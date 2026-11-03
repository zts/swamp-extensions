import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { decode } from "npm:fast-png@8.0.0";
import {
  behavior,
  contentHash,
  DEFAULT_PROMPT,
  DOCUMENT_TYPES,
  instanceName,
  normaliseDocumentType,
  toDetails,
} from "./classify_post_pdf.ts";

const SAMPLE = await Deno.readFile(
  new URL("./testdata/sample-letter.pdf", import.meta.url),
);
const SAMPLE_HASH = await contentHash(SAMPLE);

/** What @zts/qianfan-ocr's extract writes as its ocr resource. */
const OCR = {
  image: "/tmp/x/header.png",
  prompt: DEFAULT_PROMPT,
  rawOutput: "```json\n{...}\n```",
  parsed: {
    sender: "Fenwick Valley Water",
    date: "14 October 2026",
    recipient: "Ms Ada Example",
    recipient_address: "12 Heron Lane, Little Sedgeworth, MB4 7LP",
    document_type: "Statement",
    reference_numbers: {
      "Account number": "7731 0042 19",
      "Statement reference": "FVW-ST-58213",
    },
    other_details: { "Amount due": "GBP 184.62" },
  },
  parsedOk: true,
  model: "baidu/Qianfan-OCR",
  revision: "623bf5d20d446abdb36606aa4547cd0c18886fe5",
  device: "mps",
  dtype: "bfloat16",
  lockWaitMs: 0,
  loadMs: 14000,
  generateMs: 19000,
  extractedAt: "2026-11-02T17:00:00.000Z",
};

interface RunModelCall {
  definition?: string;
  method: string;
  arguments?: Record<string, unknown>;
}

interface Fakes {
  /** What runModel returns; given the call, so it can echo the name. */
  runModel?: (call: RunModelCall) => unknown;
  /** Records queryData finds; given the predicate. */
  queryData?: (predicate: string) => unknown[];
  /** A resource spec, or a record name, whose write fails. */
  failWrite?: string;
  /** A file spec, or a file name, whose write fails. */
  failFile?: string;
  /** Name of the classify-post-pdf behavior instance. */
  definitionName?: string;
}

interface Seen {
  runModel: RunModelCall[];
  queryData: string[];
  /** Whether the image runModel was given existed when it was called. */
  imageExisted: boolean[];
  imagePaths: string[];
}

function okRun(call: RunModelCall) {
  return {
    ok: true,
    resources: [{
      name: `ocr-${call.arguments?.name}`,
      specName: "ocr",
      kind: "resource",
      version: 3,
    }],
  };
}

function okQuery(attributes: Record<string, unknown> = OCR) {
  return (_predicate: string) => [{ name: "ocr-x", version: 3, attributes }];
}

async function setup() {
  const repoDir = await Deno.makeTempDir({ prefix: "classify-post-pdf-" });
  await Deno.mkdir(`${repoDir}/post`);
  await Deno.writeFile(`${repoDir}/post/Water Bill (Oct).pdf`, SAMPLE);
  return repoDir;
}

function contextFor(
  repoDir: string,
  method: string,
  fakes: Fakes,
  globalArgs: Record<string, unknown> = {},
) {
  const test = createModelTestContext({
    globalArgs,
    methodName: method,
    repoDir,
    ...(fakes.definitionName
      ? { definition: { name: fakes.definitionName } }
      : {}),
  });
  const seen: Seen = {
    runModel: [],
    queryData: [],
    imageExisted: [],
    imagePaths: [],
  };
  const context = {
    ...test.context,
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      if (specName === fakes.failWrite || name === fakes.failWrite) {
        return Promise.reject(new Error(`write of ${name} failed`));
      }
      return test.context.writeResource(specName, name, data);
    },
    createFileWriter: (specName: string, name: string) => {
      const writer = test.context.createFileWriter(specName, name);
      return {
        writeAll: (content: Uint8Array) =>
          specName === fakes.failFile || name === fakes.failFile
            ? Promise.reject(new Error(`write of ${name} failed`))
            : writer.writeAll(content),
      };
    },
    runModel: async (call: RunModelCall) => {
      seen.runModel.push(call);
      const items = (call.arguments?.items as { imagePath: string }[]) ??
        [{ imagePath: String(call.arguments?.imagePath ?? "") }];
      for (const { imagePath } of items) {
        seen.imagePaths.push(imagePath);
        seen.imageExisted.push(
          await Deno.stat(imagePath).then(() => true, () => false),
        );
      }
      return (fakes.runModel ?? okRun)(call);
    },
    queryData: (predicate: string) => {
      seen.queryData.push(predicate);
      return Promise.resolve((fakes.queryData ?? okQuery())(predicate));
    },
  };
  return { test, context, seen };
}

async function run(
  repoDir: string,
  method: keyof typeof behavior.methods,
  args: Record<string, unknown>,
  fakes: Fakes = {},
  globalArgs: Record<string, unknown> = {},
) {
  const { test, context, seen } = contextFor(
    repoDir,
    method,
    fakes,
    globalArgs,
  );
  // deno-lint-ignore no-explicit-any
  const result = await (behavior.methods[method].execute as any)(
    args,
    context,
  );
  return {
    dataHandles: result.dataHandles as { name: string }[],
    resources: test.getWrittenResources(),
    logs: test.getLogs().map((l) => JSON.stringify(l)).join("\n"),
    files: test.getWrittenFiles(),
    seen,
  };
}

async function runFailing(
  repoDir: string,
  method: keyof typeof behavior.methods,
  args: Record<string, unknown>,
  fakes: Fakes = {},
  globalArgs: Record<string, unknown> = {},
) {
  const { test, context, seen } = contextFor(
    repoDir,
    method,
    fakes,
    globalArgs,
  );
  const error = await assertRejects(() =>
    // deno-lint-ignore no-explicit-any
    (behavior.methods[method].execute as any)(args, context)
  );
  return {
    error: error as Error,
    resources: test.getWrittenResources(),
    files: test.getWrittenFiles(),
    seen,
  };
}

async function withRepo(body: (repoDir: string) => Promise<void>) {
  const repoDir = await setup();
  try {
    await body(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
}

const SCAN = { pdfPath: "post/Water Bill (Oct).pdf" };
const NAME = `Water-Bill-Oct-${SAMPLE_HASH.slice(0, 16)}`;

Deno.test("scan reads the letter through qianfan-ocr and records its details and header", async () => {
  await withRepo(async (repoDir) => {
    const { resources, files, seen } = await run(repoDir, "scan", SCAN);

    assertEquals(seen.runModel.length, 1);
    const call = seen.runModel[0];
    assertEquals(call.definition, "qianfan-ocr");
    assertEquals(call.method, "extract");
    assertEquals(call.arguments?.prompt, DEFAULT_PROMPT);
    assertEquals(call.arguments?.maxNewTokens, 1024);
    assertEquals(call.arguments?.name, NAME);
    assertEquals(seen.imageExisted, [true]);

    // The record is read back at exactly the name and version extract wrote.
    assertEquals(seen.queryData, [
      `modelName == "qianfan-ocr" && name == "ocr-${NAME}" && version == 3`,
    ]);

    assertEquals(files.length, 1);
    assertEquals(files[0].specName, "header");
    assertEquals(files[0].name, `header-${NAME}`);
    const png = decode(files[0].content);
    assertEquals(png.width > png.height, true);

    assertEquals(resources.length, 1);
    const details = resources[0];
    assertEquals(details.specName, "details");
    assertEquals(details.name, `details-${NAME}`);
    assertEquals(details.data.pdfPath, `${repoDir}/post/Water Bill (Oct).pdf`);
    assertEquals(details.data.page, 1);
    assertEquals(details.data.fraction, 0.25);
    assertEquals(details.data.dpi, 200);
    assertEquals(details.data.contentHash, SAMPLE_HASH);
    assertEquals(details.data.sender, "Fenwick Valley Water");
    assertEquals(details.data.documentType, "statement");
    assertEquals(details.data.documentTypeRaw, "Statement");
    assertEquals(details.data.referenceNumbers, {
      "Account number": "7731 0042 19",
      "Statement reference": "FVW-ST-58213",
    });
    assertEquals(details.data.parsedOk, true);
    assertEquals(details.data.ocr, {
      behavior: "qianfan-ocr",
      name: `ocr-${NAME}`,
      version: 3,
    });
    assertEquals(details.data.revision, OCR.revision);
    assertExists(details.data.scannedAt);
  });
});

Deno.test("scan removes its temporary image once qianfan-ocr has read it", async () => {
  await withRepo(async (repoDir) => {
    const { seen } = await run(repoDir, "scan", SCAN);
    assertEquals(
      await Deno.stat(seen.imagePaths[0]).then(() => true, () => false),
      false,
    );
  });
});

Deno.test("scan passes page, fraction, dpi, prompt and the ocr behavior through", async () => {
  await withRepo(async (repoDir) => {
    const { resources, files, seen } = await run(
      repoDir,
      "scan",
      {
        ...SCAN,
        page: 2,
        fraction: 0.5,
        dpi: 100,
        prompt: "Who sent this?",
        maxNewTokens: 64,
      },
      {},
      { ocrBehavior: "my-ocr" },
    );
    assertEquals(seen.runModel[0].definition, "my-ocr");
    assertEquals(seen.runModel[0].arguments?.prompt, "Who sent this?");
    assertEquals(seen.runModel[0].arguments?.maxNewTokens, 64);
    assertStringIncludes(seen.queryData[0], 'modelName == "my-ocr"');
    assertEquals(resources[0].data.page, 2);
    assertEquals(resources[0].data.fraction, 0.5);
    assertEquals(resources[0].data.dpi, 100);
    // At 100 dpi a half A4 page is about 827 x 585.
    const png = decode(files[0].content);
    assertEquals(Math.abs(png.width - 827) <= 1, true);
    assertEquals(Math.abs(png.height - 585) <= 1, true);
  });
});

Deno.test("scanning the same file again writes a new version of the same records", async () => {
  await withRepo(async (repoDir) => {
    await Deno.copyFile(
      `${repoDir}/post/Water Bill (Oct).pdf`,
      `${repoDir}/post/copy.pdf`,
    );
    const first = await run(repoDir, "scan", SCAN);
    const again = await run(repoDir, "scan", SCAN);
    assertEquals(again.resources[0].name, first.resources[0].name);

    // Same contents under another file name is a different record name.
    const copy = await run(repoDir, "scan", { pdfPath: "post/copy.pdf" });
    assertEquals(
      copy.resources[0].name,
      `details-copy-${SAMPLE_HASH.slice(0, 16)}`,
    );
  });
});

Deno.test("scan fails, naming the ocr behavior and how to set it up, when qianfan-ocr fails", async () => {
  await withRepo(async (repoDir) => {
    const { error, resources, files, seen } = await runFailing(
      repoDir,
      "scan",
      SCAN,
      {
        runModel: () => ({
          ok: false,
          error: { message: 'Definition "qianfan-ocr" not found.' },
        }),
      },
    );
    assertStringIncludes(
      error.message,
      'Definition "qianfan-ocr" not found. If',
    );
    assertStringIncludes(
      error.message,
      "swamp behavior create @zts/qianfan-ocr qianfan-ocr",
    );
    assertStringIncludes(
      error.message,
      "swamp behavior run qianfan-ocr install",
    );
    assertEquals(resources, []);
    assertEquals(files, []);
    // The temporary image is removed on failure too.
    assertEquals(
      await Deno.stat(seen.imagePaths[0]).then(() => true, () => false),
      false,
    );
  });
});

Deno.test("scan writes no header when the details write fails", async () => {
  await withRepo(async (repoDir) => {
    const { error, files } = await runFailing(repoDir, "scan", SCAN, {
      failWrite: "details",
    });
    assertStringIncludes(error.message, `details-${NAME}`);
    assertEquals(files, []);
  });
});

Deno.test("scan keeps the letter's contents out of its logs", async () => {
  await withRepo(async (repoDir) => {
    const { logs } = await run(repoDir, "scan", SCAN);
    for (const value of ["Fenwick", "Ada Example", "Heron Lane", "7731"]) {
      assertEquals(logs.includes(value), false, value);
    }
  });
});

Deno.test("scan fails without writing when qianfan-ocr returns no ocr record", async () => {
  await withRepo(async (repoDir) => {
    const { error, resources, files } = await runFailing(
      repoDir,
      "scan",
      SCAN,
      {
        runModel: () => ({ ok: true, resources: [] }),
      },
    );
    assertStringIncludes(error.message, "wrote no ocr record");
    assertEquals([resources, files], [[], []]);
  });
});

Deno.test("scan fails without writing when the ocr record at that version is gone", async () => {
  await withRepo(async (repoDir) => {
    const { error, resources, files } = await runFailing(
      repoDir,
      "scan",
      SCAN,
      {
        queryData: () => [],
      },
    );
    assertStringIncludes(error.message, `ocr-${NAME}`);
    assertStringIncludes(error.message, "version 3");
    assertEquals([resources, files], [[], []]);
  });
});

Deno.test("scan keeps the raw answer and empty fields when the model gave no JSON", async () => {
  await withRepo(async (repoDir) => {
    const { resources } = await run(repoDir, "scan", SCAN, {
      queryData: okQuery({
        ...OCR,
        rawOutput: "I cannot read this.",
        parsed: null,
        parsedOk: false,
      }),
    });
    const d = resources[0].data;
    assertEquals(d.parsedOk, false);
    assertEquals(d.rawOutput, "I cannot read this.");
    assertEquals(
      [
        d.sender,
        d.date,
        d.recipient,
        d.recipientAddress,
        d.documentType,
        d.documentTypeRaw,
      ],
      [null, null, null, null, null, null],
    );
    assertEquals(d.referenceNumbers, {});
    assertEquals(d.otherDetails, {});
  });
});

Deno.test("scan fails on a missing PDF and on a file that is not a PDF, before calling qianfan-ocr", async () => {
  await withRepo(async (repoDir) => {
    const missing = await runFailing(repoDir, "scan", {
      pdfPath: "post/nope.pdf",
    });
    assertStringIncludes(missing.error.message, "PDF not found");
    assertEquals(missing.seen.runModel, []);

    await Deno.writeTextFile(`${repoDir}/post/fake.pdf`, "hello");
    const fake = await runFailing(repoDir, "scan", {
      pdfPath: "post/fake.pdf",
    });
    assertStringIncludes(fake.error.message, "not a readable PDF");
    assertEquals(fake.seen.runModel, []);
  });
});

Deno.test("scan refuses a dpi outside 50-600 before rendering", () => {
  const args = behavior.methods.scan.arguments;
  for (const dpi of [49, 601]) {
    assertEquals(args.safeParse({ ...SCAN, dpi }).success, false);
  }
  assertEquals(args.safeParse({ ...SCAN, dpi: 600 }).success, true);
});

interface Stored {
  modelName: string;
  name: string;
  version: number;
  attributes: Record<string, unknown>;
}

type Outcome = "ok" | "error" | "notRun";

/**
 * A fake @zts/qianfan-ocr extractBatch and the data it leaves. Records are
 * named as qianfan names them (ocr-<item name>, batch-<batch name>), so a
 * caller that builds the names itself finds nothing when it gets them wrong.
 */
function fakeQianfan(options: {
  /** Each item's outcome, by its place in the batch; default ok. */
  outcome?: (i: number) => Outcome;
  /** The helper failed part way: the batch record is kept, runModel fails. */
  partial?: string;
  /** runModel fails before any item, so nothing is written. */
  fail?: string;
  /** runModel succeeds but returns no batch handle. */
  noBatchHandle?: boolean;
  /** Change the item outcomes the batch record holds, as a buggy one might. */
  mangle?: (items: Record<string, unknown>[]) => Record<string, unknown>[];
  stored?: Stored[];
} = {}) {
  const stored: Stored[] = [...(options.stored ?? [])];
  const runModel = (call: RunModelCall) => {
    if (options.fail) return { ok: false, error: { message: options.fail } };
    const args = call.arguments!;
    const items = args.items as {
      imagePath: string;
      prompt: string;
      name: string;
    }[];
    const handles: Record<string, unknown>[] = [];
    const outcomes = items.map((item, i) => {
      const status = options.outcome?.(i) ?? "ok";
      const outcome = {
        image: item.imagePath,
        prompt: item.prompt,
        status,
        record: null as string | null,
        recordVersion: null as number | null,
        error: status === "error" ? "the model failed" : null,
        generateMs: null as number | null,
      };
      if (status !== "ok") return outcome;
      const record = {
        modelName: call.definition!,
        name: `ocr-${item.name}`,
        version: 3,
        attributes: { ...OCR, image: item.imagePath },
      };
      stored.push(record);
      handles.push({ name: record.name, specName: "ocr", version: 3 });
      return {
        ...outcome,
        record: record.name,
        recordVersion: 3,
        generateMs: 19000,
      };
    });
    const count = (status: Outcome) =>
      outcomes.filter((o) => o.status === status).length;
    const batch = {
      modelName: call.definition!,
      name: `batch-${args.name}`,
      version: 1,
      attributes: {
        model: OCR.model,
        revision: OCR.revision,
        device: "mps",
        dtype: "bfloat16",
        lockWaitMs: 0,
        loadMs: 14000,
        totalMs: 60000,
        items: options.mangle ? options.mangle(outcomes) : outcomes,
        succeeded: count("ok"),
        failed: count("error"),
        notRun: count("notRun"),
        error: options.partial ?? null,
        startedAt: "2026-11-03T17:00:00.000Z",
      },
    };
    stored.push(batch);
    if (options.partial) {
      return { ok: false, error: { message: options.partial } };
    }
    if (!options.noBatchHandle) {
      handles.push({ name: batch.name, specName: "batch", version: 1 });
    }
    return { ok: true, resources: handles };
  };
  const queryData = (predicate: string) => {
    const model = /modelName == "([^"]*)"/.exec(predicate)?.[1];
    const name = /(?<![A-Za-z])name == "([^"]*)"/.exec(predicate)?.[1];
    const version = /version == (\d+)/.exec(predicate)?.[1];
    return stored.filter((r) =>
      r.modelName === model && r.name === name &&
      (version === undefined || r.version === Number(version))
    );
  };
  return { runModel, queryData, stored };
}

const COPY_NAME = `copy-${SAMPLE_HASH.slice(0, 16)}`;
const TWO = { pdfPaths: ["post/Water Bill (Oct).pdf", "post/copy.pdf"] };

async function setupTwo(repoDir: string) {
  await Deno.writeFile(`${repoDir}/post/copy.pdf`, SAMPLE);
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

const TMP_ROOT = dirOf(
  await Deno.makeTempDir().then(async (dir) => {
    await Deno.remove(dir);
    return dir;
  }),
);

/** classify-post-pdf temp dirs; for runs that never hand one to qianfan. */
async function tempDirCount(): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(TMP_ROOT)) {
    if (entry.isDirectory && entry.name.startsWith("classify-post-pdf-")) {
      count++;
    }
  }
  return count;
}

interface Letter {
  path: string;
  name: string | null;
  status: Outcome;
  details: string | null;
  error: string | null;
}

function scanBatchRecord(resources: { specName: string; data: unknown }[]) {
  const records = resources.filter((r) => r.specName === "scanBatch");
  assertEquals(records.length, 1);
  return records[0] as unknown as {
    name: string;
    data: {
      letters: Letter[];
      batch: { name: string; version: number } | null;
      succeeded: number;
      failed: number;
      notRun: number;
      loadMs: number | null;
      error: string | null;
    };
  };
}

Deno.test("scanBatch reads every letter with one extractBatch call and records each one's details and header", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const q = fakeQianfan();
    const { resources, files, seen, dataHandles } = await run(
      repoDir,
      "scanBatch",
      TWO,
      q,
    );

    // One model load: a single call carrying every letter, in order.
    assertEquals(seen.runModel.length, 1);
    const call = seen.runModel[0];
    assertEquals(call.definition, "qianfan-ocr");
    assertEquals(call.method, "extractBatch");
    const items = call.arguments?.items as Record<string, unknown>[];
    assertEquals(items.map((i) => i.name), [NAME, COPY_NAME]);
    assertEquals(items.map((i) => i.prompt), [DEFAULT_PROMPT, DEFAULT_PROMPT]);
    assertEquals(call.arguments?.maxNewTokens, 1024);
    assertEquals(seen.imageExisted, [true, true]);
    assertEquals(new Set(seen.imagePaths.map(dirOf)).size, 1);

    // The batch is read under the name qianfan gave it, and our record
    // shares its base name.
    const record = scanBatchRecord(resources);
    const base = record.name.replace(/^scan-batch-/, "");
    assertMatch(record.name, /^scan-batch-[A-Za-z0-9_-]+$/);
    assertEquals(call.arguments?.name, base);
    assertEquals(record.data.batch, { name: `batch-${base}`, version: 1 });

    // Each letter's ocr record is read at the name and version the batch
    // record gives it.
    for (const name of [NAME, COPY_NAME]) {
      assertEquals(
        seen.queryData.includes(
          `modelName == "qianfan-ocr" && name == "ocr-${name}" && version == 3`,
        ),
        true,
        name,
      );
    }

    const details = resources.filter((r) => r.specName === "details");
    assertEquals(details.map((r) => r.name), [
      `details-${NAME}`,
      `details-${COPY_NAME}`,
    ]);
    assertEquals(details[1].data.pdfPath, `${repoDir}/post/copy.pdf`);
    assertEquals(details[0].data.sender, "Fenwick Valley Water");
    assertEquals(details[0].data.documentType, "statement");
    assertEquals(details[0].data.ocr, {
      behavior: "qianfan-ocr",
      name: `ocr-${NAME}`,
      version: 3,
    });
    assertEquals(details[0].data.loadMs, 14000);
    assertEquals(files.map((f) => f.name), [
      `header-${NAME}`,
      `header-${COPY_NAME}`,
    ]);
    const png = decode(files[0].content);
    assertEquals(png.width > png.height, true);

    assertEquals(record.data.letters, [
      {
        path: `${repoDir}/post/Water Bill (Oct).pdf`,
        name: NAME,
        status: "ok",
        details: `details-${NAME}`,
        error: null,
      },
      {
        path: `${repoDir}/post/copy.pdf`,
        name: COPY_NAME,
        status: "ok",
        details: `details-${COPY_NAME}`,
        error: null,
      },
    ]);
    assertEquals(
      [record.data.succeeded, record.data.failed, record.data.notRun],
      [2, 0, 0],
    );
    assertEquals(record.data.loadMs, 14000);
    assertEquals(record.data.error, null);

    // Every record it wrote is returned, scan-batch last.
    assertEquals(dataHandles.map((h) => h.name), [
      `details-${NAME}`,
      `header-${NAME}`,
      `details-${COPY_NAME}`,
      `header-${COPY_NAME}`,
      record.name,
    ]);
    assertEquals(await exists(dirOf(seen.imagePaths[0])), false);
  });
});

Deno.test("scanBatch passes page, fraction, dpi, prompt and the ocr behavior to every letter", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const q = fakeQianfan();
    const { resources, files, seen } = await run(
      repoDir,
      "scanBatch",
      {
        ...TWO,
        page: 2,
        fraction: 0.5,
        dpi: 100,
        prompt: "Who sent this?",
        maxNewTokens: 64,
      },
      q,
      { ocrBehavior: "my-ocr" },
    );
    assertEquals(seen.runModel[0].definition, "my-ocr");
    const items = seen.runModel[0].arguments?.items as Record<
      string,
      unknown
    >[];
    assertEquals(items.map((i) => i.prompt), [
      "Who sent this?",
      "Who sent this?",
    ]);
    assertEquals(seen.runModel[0].arguments?.maxNewTokens, 64);
    const details = resources.filter((r) => r.specName === "details");
    assertEquals(details.length, 2);
    assertEquals(details[1].data.page, 2);
    assertEquals(details[1].data.dpi, 100);
    assertEquals(details[1].data.prompt, "Who sent this?");
    const png = decode(files[1].content);
    assertEquals(Math.abs(png.width - 827) <= 1, true);
  });
});

Deno.test("scanBatch records a letter the model could not read as failed and writes the rest", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const q = fakeQianfan({ outcome: (i) => i === 0 ? "error" : "ok" });
    const { resources, files } = await run(repoDir, "scanBatch", TWO, q);
    const details = resources.filter((r) => r.specName === "details");
    assertEquals(details.map((r) => r.name), [`details-${COPY_NAME}`]);
    assertEquals(files.map((f) => f.name), [`header-${COPY_NAME}`]);
    const record = scanBatchRecord(resources);
    assertEquals(record.data.letters[0].status, "error");
    assertEquals(record.data.letters[0].details, null);
    assertEquals(record.data.letters[0].error, "the model failed");
    assertEquals(
      [record.data.succeeded, record.data.failed, record.data.notRun],
      [1, 1, 0],
    );
  });
});

Deno.test("scanBatch never sends a PDF it cannot read, and records it as failed", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeTextFile(`${repoDir}/post/fake.pdf`, "hello");
    const q = fakeQianfan();
    const { resources, seen } = await run(repoDir, "scanBatch", {
      pdfPaths: ["post/nope.pdf", "post/fake.pdf", SCAN.pdfPath],
    }, q);
    const items = seen.runModel[0].arguments?.items as Record<
      string,
      unknown
    >[];
    assertEquals(items.map((i) => i.name), [NAME]);
    const record = scanBatchRecord(resources);
    assertEquals(record.data.letters.map((l) => l.status), [
      "error",
      "error",
      "ok",
    ]);
    assertEquals(record.data.letters[0].name, null);
    assertStringIncludes(record.data.letters[0].error!, "PDF not found");
    assertStringIncludes(record.data.letters[1].error!, "not a readable PDF");
    assertEquals(
      [record.data.succeeded, record.data.failed, record.data.notRun],
      [1, 2, 0],
    );
  });
});

Deno.test("scanBatch on no PDFs writes an empty scan-batch record and succeeds without calling qianfan-ocr", async () => {
  await withRepo(async (repoDir) => {
    const before = await tempDirCount();
    const q = fakeQianfan();
    const { resources, files, seen, dataHandles } = await run(
      repoDir,
      "scanBatch",
      { pdfPaths: [] },
      q,
    );
    assertEquals(seen.runModel, []);
    const record = scanBatchRecord(resources);
    assertEquals(record.data.letters, []);
    assertEquals(record.data.batch, null);
    assertEquals(
      [record.data.succeeded, record.data.failed, record.data.notRun],
      [0, 0, 0],
    );
    assertEquals(files, []);
    assertEquals(dataHandles.map((h) => h.name), [record.name]);
    assertEquals(await tempDirCount(), before);
  });
});

Deno.test("scanBatch fails, after recording why, when no PDF given can be read", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeTextFile(`${repoDir}/post/fake.pdf`, "hello");
    const before = await tempDirCount();
    const q = fakeQianfan();
    const { error, resources, seen } = await runFailing(
      repoDir,
      "scanBatch",
      { pdfPaths: ["post/nope.pdf", "post/fake.pdf"] },
      q,
    );
    assertEquals(seen.runModel, []);
    assertStringIncludes(error.message, "none of the 2 letters");
    assertStringIncludes(error.message, "PDF not found");
    const record = scanBatchRecord(resources);
    assertEquals(record.data.failed, 2);
    assertEquals(await tempDirCount(), before);
  });
});

Deno.test("scanBatch keeps what was read when the helper fails part way, then fails", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const q = fakeQianfan({
      outcome: (i) => i === 0 ? "ok" : "notRun",
      partial: "qianfan_ocr.py extract-batch exited with code 1",
    });
    const { error, resources, files, seen } = await runFailing(
      repoDir,
      "scanBatch",
      TWO,
      q,
    );
    assertStringIncludes(error.message, "exited with code 1");
    const details = resources.filter((r) => r.specName === "details");
    assertEquals(details.map((r) => r.name), [`details-${NAME}`]);
    assertEquals(files.map((f) => f.name), [`header-${NAME}`]);
    const record = scanBatchRecord(resources);
    assertEquals(record.data.letters.map((l) => l.status), ["ok", "notRun"]);
    assertStringIncludes(record.data.error!, "exited with code 1");
    assertEquals(
      record.data.batch?.name,
      `batch-${seen.runModel[0].arguments?.name}`,
    );
    assertEquals(await exists(dirOf(seen.imagePaths[0])), false);
  });
});

Deno.test("scanBatch fails, naming how to set up qianfan-ocr, when the batch fails before any letter", async () => {
  await withRepo(async (repoDir) => {
    const q = fakeQianfan({ fail: 'Definition "qianfan-ocr" not found.' });
    const { error, resources, files, seen } = await runFailing(
      repoDir,
      "scanBatch",
      { pdfPaths: [SCAN.pdfPath] },
      q,
    );
    assertStringIncludes(error.message, 'Definition "qianfan-ocr" not found');
    assertStringIncludes(
      error.message,
      "swamp behavior create @zts/qianfan-ocr qianfan-ocr",
    );
    assertStringIncludes(
      error.message,
      "swamp behavior run qianfan-ocr install",
    );
    assertEquals(resources.filter((r) => r.specName === "details"), []);
    assertEquals(files, []);
    const record = scanBatchRecord(resources);
    assertEquals(record.data.batch, null);
    assertEquals(record.data.letters.map((l) => l.status), ["notRun"]);
    assertEquals(await exists(dirOf(seen.imagePaths[0])), false);
  });
});

Deno.test("scanBatch says which qianfan-ocr version it needs when the installed one has no extractBatch", async () => {
  await withRepo(async (repoDir) => {
    // swamp's runModel text for a method the target type lacks.
    const q = fakeQianfan({
      fail:
        "Unknown method 'extractBatch'. Available methods: install, extract",
    });
    const { error } = await runFailing(
      repoDir,
      "scanBatch",
      { pdfPaths: [SCAN.pdfPath] },
      q,
    );
    assertStringIncludes(error.message, "Unknown method 'extractBatch'");
    assertStringIncludes(error.message, "@zts/qianfan-ocr 2026.11.03.1");
    assertStringIncludes(
      error.message,
      "swamp extension pull @zts/qianfan-ocr",
    );
    assertStringIncludes(
      error.message,
      "swamp behavior run qianfan-ocr install",
    );
  });
});

Deno.test("scanBatch gives the setup hint, not the upgrade one, for other extractBatch errors", async () => {
  await withRepo(async (repoDir) => {
    const q = fakeQianfan({
      fail: "extractBatch failed: image not found: /tmp/x.png",
    });
    const { error } = await runFailing(
      repoDir,
      "scanBatch",
      { pdfPaths: [SCAN.pdfPath] },
      q,
    );
    assertEquals(error.message.includes("2026.11.03.1"), false);
    assertStringIncludes(
      error.message,
      "swamp behavior create @zts/qianfan-ocr qianfan-ocr",
    );
  });
});

Deno.test("scanBatch fails, marking the letters it cannot match, when the batch record does not match what was sent", async () => {
  for (
    const mangle of [
      // An item missing from the end.
      (items: Record<string, unknown>[]) => items.slice(0, 1),
      // An item naming another letter's record.
      (items: Record<string, unknown>[]) =>
        items.map((item, i) =>
          i === 1 ? { ...item, record: items[0].record } : item
        ),
    ]
  ) {
    await withRepo(async (repoDir) => {
      await setupTwo(repoDir);
      const q = fakeQianfan({ mangle });
      const { error, resources } = await runFailing(
        repoDir,
        "scanBatch",
        TWO,
        q,
      );
      assertStringIncludes(error.message, "does not match");
      const record = scanBatchRecord(resources);
      assertEquals(record.data.letters.map((l) => l.status), ["ok", "error"]);
      assertStringIncludes(record.data.letters[1].error!, "does not match");
      assertEquals(record.data.letters[1].details, null);
      assertStringIncludes(record.data.error!, "does not match");
    });
  }
});

Deno.test("scanBatch fails when qianfan-ocr succeeds without returning its batch record", async () => {
  await withRepo(async (repoDir) => {
    const q = fakeQianfan({ noBatchHandle: true });
    const { error, resources } = await runFailing(
      repoDir,
      "scanBatch",
      { pdfPaths: [SCAN.pdfPath] },
      q,
    );
    assertStringIncludes(error.message, "no batch record");
    assertEquals(resources.filter((r) => r.specName === "details"), []);
  });
});

Deno.test("scanBatch marks a letter failed when its details or header write fails, and writes the rest", async () => {
  for (
    const fail of [
      { failWrite: `details-${NAME}` },
      { failFile: `header-${NAME}` },
    ]
  ) {
    await withRepo(async (repoDir) => {
      await setupTwo(repoDir);
      const q = fakeQianfan();
      const { resources, files } = await run(repoDir, "scanBatch", TWO, {
        ...q,
        ...fail,
      });
      assertEquals(
        files.map((f) => f.name).includes(`header-${COPY_NAME}`),
        true,
      );
      const record = scanBatchRecord(resources);
      assertEquals(record.data.letters.map((l) => l.status), ["error", "ok"]);
      assertStringIncludes(record.data.letters[0].error!, "failed");
      // A details record written before the header failed is still named.
      assertEquals(
        record.data.letters[0].details,
        fail.failFile ? `details-${NAME}` : null,
      );
      assertEquals(
        [record.data.succeeded, record.data.failed],
        [1, 1],
      );
    });
  }
});

Deno.test("scanBatch reads each letter's ocr record through the batch, never a stale one by name", async () => {
  await withRepo(async (repoDir) => {
    const q = fakeQianfan({
      stored: [{
        modelName: "qianfan-ocr",
        name: `ocr-${NAME}`,
        version: 9,
        attributes: { ...OCR, parsed: { sender: "Stale Sender" } },
      }],
    });
    const { resources } = await run(repoDir, "scanBatch", {
      pdfPaths: [SCAN.pdfPath],
    }, q);
    const details = resources.filter((r) => r.specName === "details");
    assertEquals(details[0].data.sender, "Fenwick Valley Water");
    assertEquals(
      (details[0].data.ocr as Record<string, unknown>).version,
      3,
    );
  });
});

Deno.test("scanBatch sends one of two files that would share a record, and says which it skipped", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(`${repoDir}/post/Water-Bill-Oct.pdf`, SAMPLE);
    const q = fakeQianfan();
    const { seen, logs } = await run(repoDir, "scanBatch", {
      pdfPaths: [SCAN.pdfPath, "post/Water-Bill-Oct.pdf"],
    }, q);
    const items = seen.runModel[0].arguments?.items as Record<
      string,
      unknown
    >[];
    assertEquals(items.map((i) => i.name), [NAME]);
    assertStringIncludes(logs, "Skipping");
    assertStringIncludes(logs, "Water-Bill-Oct.pdf");
  });
});

Deno.test("scanBatch reads a list listPdfs wrote under this behavior instance's own name", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const list = (modelName: string, name: string, paths: string[]) => ({
      modelName,
      name,
      version: 1,
      attributes: {
        directory: `${repoDir}/post`,
        files: paths.map((path) => ({ path, name: "ignored" })),
        listedAt: "2026-11-03T17:00:00.000Z",
      },
    });
    const run1 = "6b0f3c52-8f1e-4c47-9a3d-2e5b7c1d9f40";
    const q = fakeQianfan({
      stored: [
        list("my-post", `pdf-list-${run1}`, [`${repoDir}/post/copy.pdf`]),
        list("classify-post-pdf", `pdf-list-${run1}`, [
          `${repoDir}/post/Water Bill (Oct).pdf`,
        ]),
        list("my-post", "pdf-list", [`${repoDir}/post/Water Bill (Oct).pdf`]),
      ],
    });
    const fakes = { ...q, definitionName: "my-post" };

    const byRun = await run(repoDir, "scanBatch", { list: run1 }, fakes);
    const items = byRun.seen.runModel[0].arguments?.items as Record<
      string,
      unknown
    >[];
    assertEquals(items.map((i) => i.name), [COPY_NAME]);

    // The list listPdfs writes when it is given no run.
    const byName = await run(repoDir, "scanBatch", { list: "pdf-list" }, fakes);
    const named = byName.seen.runModel[0].arguments?.items as Record<
      string,
      unknown
    >[];
    assertEquals(named.map((i) => i.name), [NAME]);

    const missing = await runFailing(repoDir, "scanBatch", { list: "nope" }, {
      ...fakes,
    });
    assertStringIncludes(missing.error.message, "pdf-list-nope");
    assertStringIncludes(missing.error.message, "my-post");
    assertEquals(missing.seen.runModel, []);
  });
});

Deno.test("scanBatch takes exactly one of pdfPaths and list", () => {
  const args = behavior.methods.scanBatch.arguments;
  assertEquals(args.safeParse({}).success, false);
  assertEquals(
    args.safeParse({ pdfPaths: [SCAN.pdfPath], list: "x" }).success,
    false,
  );
  assertEquals(args.safeParse({ pdfPaths: [] }).success, true);
  assertEquals(args.safeParse({ list: "x" }).success, true);
  assertEquals(args.safeParse({ list: "../x" }).success, false);
});

Deno.test("scanBatch keeps the letters' contents out of its logs", async () => {
  await withRepo(async (repoDir) => {
    await setupTwo(repoDir);
    const { logs } = await run(repoDir, "scanBatch", TWO, fakeQianfan());
    for (const value of ["Fenwick", "Ada Example", "Heron Lane", "7731"]) {
      assertEquals(logs.includes(value), false, value);
    }
  });
});

Deno.test("listPdfs lists the PDFs in a directory, sorted, with their record names", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(`${repoDir}/post/a.PDF`, SAMPLE.slice(0, 100));
    await Deno.writeTextFile(`${repoDir}/post/notes.txt`, "not a pdf");
    await Deno.mkdir(`${repoDir}/post/sub.pdf`);
    const { resources } = await run(repoDir, "listPdfs", { directory: "post" });
    assertEquals(resources[0].specName, "pdfList");
    assertEquals(resources[0].name, "pdf-list");
    const files = resources[0].data.files as { path: string; name: string }[];
    assertEquals(files.map((f) => f.path), [
      `${repoDir}/post/a.PDF`,
      `${repoDir}/post/Water Bill (Oct).pdf`,
    ]);
    assertEquals(files[1].name, NAME);
  });
});

Deno.test("listPdfs names its list after the run it is given", async () => {
  await withRepo(async (repoDir) => {
    const run1 = "6b0f3c52-8f1e-4c47-9a3d-2e5b7c1d9f40";
    const { resources } = await run(repoDir, "listPdfs", {
      directory: "post",
      run: run1,
    });
    assertEquals(resources[0].name, `pdf-list-${run1}`);
    assertEquals(
      behavior.methods.listPdfs.arguments.safeParse({
        directory: "post",
        run: "../x",
      }).success,
      false,
    );
  });
});

Deno.test("listPdfs follows symlinks to PDFs and warns about broken ones", async () => {
  await withRepo(async (repoDir) => {
    await Deno.mkdir(`${repoDir}/elsewhere`);
    await Deno.writeFile(
      `${repoDir}/elsewhere/other.pdf`,
      SAMPLE.slice(0, 100),
    );
    await Deno.symlink(
      `${repoDir}/elsewhere/other.pdf`,
      `${repoDir}/post/linked.pdf`,
    );
    await Deno.symlink(`${repoDir}/elsewhere`, `${repoDir}/post/dir.pdf`);
    await Deno.symlink(
      `${repoDir}/elsewhere/gone.pdf`,
      `${repoDir}/post/broken.pdf`,
    );
    const { resources, logs } = await run(repoDir, "listPdfs", {
      directory: "post",
    });
    const files = resources[0].data.files as { path: string; name: string }[];
    assertEquals(files.map((f) => f.path), [
      `${repoDir}/post/linked.pdf`,
      `${repoDir}/post/Water Bill (Oct).pdf`,
    ]);
    assertStringIncludes(logs, "broken.pdf");
  });
});

Deno.test("listPdfs keeps one of two files that would share a record, and says which it skipped", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(`${repoDir}/post/Water-Bill-Oct.pdf`, SAMPLE);
    await Deno.writeFile(`${repoDir}/post/other.pdf`, SAMPLE.slice(0, 100));
    const { resources, logs } = await run(repoDir, "listPdfs", {
      directory: "post",
    });
    const files = resources[0].data.files as { path: string; name: string }[];
    assertEquals(files.length, 2);
    assertEquals(files.filter((f) => f.name === NAME).length, 1);
    assertStringIncludes(logs, "Water-Bill-Oct.pdf");
    assertStringIncludes(logs, "Water Bill (Oct).pdf");
    assertStringIncludes(logs, "Skipping");
  });
});

Deno.test("instanceName is the safe file stem and the first 16 hex of the content hash", () => {
  const hash = "0123456789abcdef".repeat(4);
  assertEquals(
    instanceName("/p/Water Bill (Oct).pdf", hash),
    "Water-Bill-Oct-0123456789abcdef",
  );
  for (
    const path of [
      "/p/Rechnung März.pdf",
      "/p/ .pdf",
      "/p/.pdf",
      "/p/日本.PDF",
      "/p/a b.pdf",
    ]
  ) {
    assertMatch(instanceName(path, hash), /^[A-Za-z0-9_-]+$/);
  }
  assertEquals(instanceName("/p/ .pdf", hash), "letter-0123456789abcdef");
});

Deno.test("instanceName keeps at most 64 characters of the stem", () => {
  const hash = "0123456789abcdef".repeat(4);
  const name = instanceName(`/p/${"a".repeat(250)}.pdf`, hash);
  assertEquals(name, `${"a".repeat(64)}-0123456789abcdef`);
  // A cut that ends on a separator does not leave a trailing hyphen.
  assertEquals(
    instanceName(`/p/${"b".repeat(63)} c.pdf`, hash),
    `${"b".repeat(63)}-0123456789abcdef`,
  );
});

Deno.test("contentHash is the SHA-256 of the bytes in hex", async () => {
  assertEquals(
    await contentHash(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("normaliseDocumentType matches the set regardless of case and spacing", () => {
  assertEquals(normaliseDocumentType("Statement "), {
    documentType: "statement",
    documentTypeRaw: "Statement ",
  });
  assertEquals(normaliseDocumentType("BILL").documentType, "bill");
  for (const t of DOCUMENT_TYPES) {
    assertEquals(normaliseDocumentType(t).documentType, t);
  }
});

Deno.test("normaliseDocumentType maps other words to other and keeps them", () => {
  assertEquals(normaliseDocumentType("tax demand"), {
    documentType: "other",
    documentTypeRaw: "tax demand",
  });
});

Deno.test("normaliseDocumentType maps a missing or empty type to null, not other", () => {
  for (
    const raw of [
      null,
      undefined,
      "",
      "  ",
      "unknown",
      "Unknown",
      "none",
      "null",
      "N/A",
    ]
  ) {
    assertEquals(normaliseDocumentType(raw).documentType, null, String(raw));
  }
  assertEquals(normaliseDocumentType("unknown").documentTypeRaw, "unknown");
  assertEquals(normaliseDocumentType(undefined).documentTypeRaw, null);
});

Deno.test("toDetails coerces fields and drops empty references", () => {
  const d = toDetails({
    sender: { name: "Fenwick" },
    date: 20261014,
    recipient: "",
    reference_numbers: { a: "1", b: null, c: 2 },
    other_details: ["not", "an", "object"],
  });
  assertEquals(d.sender, '{"name":"Fenwick"}');
  assertEquals(d.date, "20261014");
  assertEquals(d.recipient, null);
  assertEquals(d.recipientAddress, null);
  assertEquals(d.referenceNumbers, { a: "1", c: "2" });
  assertEquals(d.otherDetails, {});
});
