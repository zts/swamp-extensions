import { assertEquals } from "jsr:@std/assert@1.0.19";
import { behavior } from "./filer.ts";
import { contentHash } from "./inbound.ts";

interface ScannerRecord {
  name: string;
  version: number;
  modelId: string;
  modelType: string;
  attributes?: Record<string, unknown>;
}

const BILL = "FileCabinet/Thames Water/2023-05-18 Thames Water bill.pdf";

/**
 * A repo with Inbound/ReadyToFile and a FileCabinet holding the given sender
 * folders, and a fake context for the filer reading the scanner's records.
 */
async function setup(folders: string[] = ["Thames Water"]) {
  const repoDir = await Deno.makeTempDir({ prefix: "home-mail-room-filer-" });
  await Deno.mkdir(`${repoDir}/Inbound/ReadyToFile`, { recursive: true });
  for (const f of folders) {
    await Deno.mkdir(`${repoDir}/FileCabinet/${f}`, { recursive: true });
  }
  const stored = new Map<string, Record<string, unknown>>();
  const lifetimes = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const scanner: ScannerRecord[] = [];
  const scannerFiles = new Map<string, Uint8Array>();

  const context = {
    globalArgs: {},
    repoDir,
    modelType: "@zts/home-mail-room/filer",
    modelId: "filer",
    logger: { info() {}, warning() {} },
    readResource: (name: string) => Promise.resolve(stored.get(name) ?? null),
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: { lifetime?: string },
    ) => {
      stored.set(name, data);
      lifetimes.set(name, overrides?.lifetime ?? "spec");
      return Promise.resolve({ name, specName, version: 1 });
    },
    createFileWriter: (
      specName: string,
      name: string,
      overrides?: { lifetime?: string },
    ) => ({
      writeAll: (content: Uint8Array) => {
        files.set(name, content);
        lifetimes.set(name, overrides?.lifetime ?? "spec");
        return Promise.resolve({ name, specName, version: 1 });
      },
    }),
    deleteResource: (name: string) => {
      stored.delete(name);
      files.delete(name);
      return Promise.resolve();
    },
    queryData: (predicate: string) =>
      Promise.resolve(
        predicate.includes('modelName == "scanner"')
          ? scanner.filter((r) => predicate.includes(JSON.stringify(r.name)))
          : [],
      ),
    dataRepository: {
      getContent: (type: string, modelId: string, name: string) =>
        Promise.resolve(
          modelId === "scn" && type === "@zts/home-mail-room/scanner"
            ? scannerFiles.get(name) ?? null
            : modelId === "filer"
            ? files.get(name) ?? null
            : null,
        ),
      findAllForModel: () =>
        Promise.resolve([...stored.keys(), ...files.keys()].map((name) => ({
          name,
        }))),
    },
  };

  /** Put a letter the scanner read into ReadyToFile. */
  async function addLetter(
    fileName: string,
    details: Record<string, unknown> | null = {},
    text = fileName,
  ) {
    const bytes = new TextEncoder().encode(`%PDF-1.4 ${text}`);
    const path = `${repoDir}/Inbound/ReadyToFile/${fileName}`;
    await Deno.writeFile(path, bytes);
    const hash = await contentHash(bytes);
    const short = hash.slice(0, 16);
    if (details) {
      scanner.push({
        name: `details-${short}`,
        version: 1,
        modelId: "scn",
        modelType: "@zts/home-mail-room/scanner",
        attributes: {
          contentHash: hash,
          sender: "Thames Water",
          date: "18 May 2023",
          documentType: "bill",
          parsedOk: true,
          referenceNumbers: { account: "123" },
          ...details,
        },
      });
      scanner.push({
        name: `header-${short}`,
        version: 1,
        modelId: "scn",
        modelType: "@zts/home-mail-room/scanner",
      });
      scannerFiles.set(`header-${short}`, new Uint8Array([137, 80, 78, 71]));
    }
    return { path, bytes, hash, id: `letter-${short}` };
  }

  // deno-lint-ignore no-explicit-any
  const methods = behavior.methods as any;
  const fileReady = () => methods.fileReady.execute({}, context);
  const decide = (decisions: Record<string, unknown>[]) =>
    methods.decide.execute({ decisions }, context);

  return {
    repoDir,
    context,
    stored,
    lifetimes,
    files,
    addLetter,
    fileReady,
    decide,
  };
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

Deno.test("fileReady files a clean letter and archives its original unchanged", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();

  assertEquals(await Deno.readFile(`${s.repoDir}/${BILL}`), letter.bytes);
  const archived = `${s.repoDir}/Inbound/Archived/a.pdf`;
  assertEquals(await Deno.readFile(archived), letter.bytes);
  assertEquals(await exists(letter.path), false);
  const record = s.stored.get(letter.id)!;
  assertEquals(record.state, "filed");
  assertEquals(record.archivedPath, archived);
  assertEquals(record.destination, `${s.repoDir}/${BILL}`);
  assertEquals(record.cabinetDir, `${s.repoDir}/FileCabinet`);
  assertEquals(
    (record.extracted as Record<string, unknown>).referenceNumbers,
    { account: "123" },
  );
});

Deno.test("a filed letter's record and header expire after the retention", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  assertEquals(s.lifetimes.get(letter.id), "30d");
  assertEquals(s.lifetimes.get(letter.id.replace("letter-", "header-")), "30d");
});

Deno.test("fileReady holds a letter whose sender has no cabinet folder, leaving it in ReadyToFile", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  const record = s.stored.get(letter.id)!;
  assertEquals(record.state, "held");
  assertEquals(record.reasons, [
    'No FileCabinet folder for the sender "Thames Water"',
  ]);
  assertEquals(await exists(letter.path), true);
  // The header comes along for the person deciding.
  assertEquals(s.files.has(letter.id.replace("letter-", "header-")), true);
});

Deno.test("fileReady holds a letter it could not read a date or type from", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf", {
    date: "sometime",
    documentType: null,
  });
  await s.fileReady();
  assertEquals(s.stored.get(letter.id)!.reasons, [
    'Could not read the date "sometime"',
    "No document type was read",
  ]);
});

Deno.test("fileReady holds a letter nothing was read off, saying how to read it", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf", null);
  await s.fileReady();
  const record = s.stored.get(letter.id)!;
  assertEquals(record.state, "held");
  assertEquals(
    (record.reasons as string[])[0].includes("back in Incoming"),
    true,
  );
});

Deno.test("fileReady marks a conflict when another file holds the destination", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await Deno.writeTextFile(`${s.repoDir}/${BILL}`, "another letter");
  await s.fileReady();
  const record = s.stored.get(letter.id)!;
  assertEquals(record.state, "conflict");
  assertEquals(record.destination, `${s.repoDir}/${BILL}`);
  assertEquals(
    await Deno.readTextFile(`${s.repoDir}/${BILL}`),
    "another letter",
  );
  assertEquals(await exists(letter.path), true);
});

Deno.test("fileReady reviews a held letter again, filing it once its folder exists", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  assertEquals(s.stored.get(letter.id)!.state, "held");
  await Deno.mkdir(`${s.repoDir}/FileCabinet/Thames Water`, {
    recursive: true,
  });
  await s.fileReady();
  assertEquals(s.stored.get(letter.id)!.state, "filed");
});

Deno.test("fileReady leaves a letter a person has decided alone", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  const before = s.stored.get(letter.id)!;
  const decided = {
    ...before,
    proposal: {
      ...before.proposal as Record<string, unknown>,
      sender: "Person's sender",
    },
    decision: { action: "file" },
  };
  s.stored.set(letter.id, decided);
  await s.fileReady();
  assertEquals(s.stored.get(letter.id), decided);
});

Deno.test("fileReady moves a copy of a letter already filed straight to Archived", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  const filed = s.stored.get(letter.id);

  await Deno.writeFile(
    `${s.repoDir}/Inbound/ReadyToFile/copy.pdf`,
    letter.bytes,
  );
  await s.fileReady();
  assertEquals(
    await Deno.readFile(`${s.repoDir}/Inbound/Archived/copy.pdf`),
    letter.bytes,
  );
  assertEquals(s.stored.get(letter.id), filed);
});

Deno.test("fileReady reviews a skipped letter put back into ReadyToFile", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  await s.decide([{ letter: letter.id, action: "skip" }]);
  assertEquals(s.stored.get(letter.id)!.state, "skipped");

  await Deno.mkdir(`${s.repoDir}/FileCabinet/Thames Water`, {
    recursive: true,
  });
  await Deno.rename(`${s.repoDir}/Inbound/Skipped/a.pdf`, letter.path);
  await s.fileReady();
  assertEquals(s.stored.get(letter.id)!.state, "filed");
});

Deno.test("fileReady drops the record of a held letter whose file left ReadyToFile", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  await Deno.remove(letter.path);
  await s.fileReady();
  assertEquals(s.stored.has(letter.id), false);
  assertEquals(s.files.has(letter.id.replace("letter-", "header-")), false);
});

Deno.test("a letter whose destination already holds it counts as filed", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await Deno.writeFile(`${s.repoDir}/${BILL}`, letter.bytes);
  await s.fileReady();
  assertEquals(s.stored.get(letter.id)!.state, "filed");
});

Deno.test("filing again after the original was archived finishes the job", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  // An interrupted filing: the original reached Archived, the record did not.
  await Deno.mkdir(`${s.repoDir}/Inbound/Archived`);
  await Deno.rename(letter.path, `${s.repoDir}/Inbound/Archived/a.pdf`);
  await s.decide([{
    letter: letter.id,
    action: "file",
    sender: "Thames Water",
  }]);
  assertEquals(s.stored.get(letter.id)!.state, "filed");
  assertEquals(await Deno.readFile(`${s.repoDir}/${BILL}`), letter.bytes);
});

Deno.test("a letter changed since it was scanned is held, not filed", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  await Deno.writeTextFile(letter.path, "changed");
  await s.decide([{
    letter: letter.id,
    action: "file",
    sender: "Thames Water",
  }]);
  const record = s.stored.get(letter.id)!;
  assertEquals(record.state, "held");
  assertEquals(
    (record.reasons as string[])[0].includes("has changed"),
    true,
  );
});

Deno.test("decide files a held letter with the person's sender and file name", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf", { sender: "Halifax" });
  await s.fileReady();
  await s.decide([{
    letter: letter.id,
    action: "file",
    sender: "Halifax Bank",
    filename: "Mortgage offer.pdf",
  }]);
  const dest = `${s.repoDir}/FileCabinet/Halifax Bank/Mortgage offer.pdf`;
  assertEquals(await Deno.readFile(dest), letter.bytes);
  assertEquals(s.stored.get(letter.id)!.state, "filed");
});

Deno.test("decide does not overwrite another file unless told to", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await Deno.writeTextFile(`${s.repoDir}/${BILL}`, "another letter");
  await s.fileReady();
  await s.decide([{ letter: letter.id, action: "file" }]);
  assertEquals(s.stored.get(letter.id)!.state, "conflict");
  assertEquals(
    await Deno.readTextFile(`${s.repoDir}/${BILL}`),
    "another letter",
  );

  await s.decide([{ letter: letter.id, action: "file", overwrite: true }]);
  assertEquals(s.stored.get(letter.id)!.state, "filed");
  assertEquals(await Deno.readFile(`${s.repoDir}/${BILL}`), letter.bytes);
});

Deno.test("decide moves a skipped letter into Skipped unchanged", async () => {
  const s = await setup([]);
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  await s.decide([{ letter: letter.id, action: "skip" }]);
  const skipped = `${s.repoDir}/Inbound/Skipped/a.pdf`;
  assertEquals(await Deno.readFile(skipped), letter.bytes);
  const record = s.stored.get(letter.id)!;
  assertEquals([record.state, record.pdfPath], ["skipped", skipped]);
  assertEquals(s.lifetimes.get(letter.id), "30d");
});

Deno.test("one decision that cannot be applied does not stop the rest", async () => {
  const s = await setup([]);
  const a = await s.addLetter("a.pdf", {}, "one");
  const b = await s.addLetter("b.pdf", {}, "two");
  await s.fileReady();
  await s.decide([
    { letter: a.id, action: "file", date: "2023-02-30" },
    { letter: b.id, action: "file", title: "Second" },
  ]);
  const held = s.stored.get(a.id)!;
  assertEquals(held.state, "held");
  assertEquals(
    (held.reasons as string[]).some((r) => r.includes("date")),
    true,
  );
  assertEquals(s.stored.get(b.id)!.state, "filed");
});

Deno.test("decide leaves a letter that has already been filed alone", async () => {
  const s = await setup();
  const letter = await s.addLetter("a.pdf");
  await s.fileReady();
  const filed = s.stored.get(letter.id);
  await s.decide([{ letter: letter.id, action: "skip" }]);
  assertEquals(s.stored.get(letter.id), filed);
});
