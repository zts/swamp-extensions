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
  /** A resource spec whose write fails. */
  failWrite?: string;
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
      if (specName === fakes.failWrite) {
        return Promise.reject(new Error(`write of ${name} failed`));
      }
      return test.context.writeResource(specName, name, data);
    },
    runModel: async (call: RunModelCall) => {
      seen.runModel.push(call);
      const image = String(call.arguments?.imagePath ?? "");
      seen.imagePaths.push(image);
      seen.imageExisted.push(
        await Deno.stat(image).then(() => true, () => false),
      );
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
  await (behavior.methods[method].execute as any)(args, context);
  return {
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
) {
  const { test, context, seen } = contextFor(repoDir, method, fakes);
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
