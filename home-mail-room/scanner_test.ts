import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { contentHash } from "./inbound.ts";
import { DOCUMENT_TYPES } from "./filing.ts";
import {
  behavior,
  DEFAULT_PROMPT,
  normaliseDocumentType,
  toDetails,
} from "./scanner.ts";

const SAMPLE = await Deno.readFile(
  new URL("./testdata/sample-letter.pdf", import.meta.url),
);
const HASH = await contentHash(SAMPLE);
const SHORT = HASH.slice(0, 16);

const PARSED = {
  sender: "Fenwick Valley Water",
  date: "14 October 2026",
  recipient: "Ms Ada Example",
  recipient_address: "12 Heron Lane, Little Sedgeworth, MB4 7LP",
  document_type: "Statement",
  reference_numbers: { "Account number": "7731 0042 19" },
  other_details: { "Amount due": "GBP 184.62" },
};

interface RunModelCall {
  definition?: string;
  method: string;
  arguments?: Record<string, unknown>;
}

interface Stored {
  modelName: string;
  name: string;
  version: number;
  attributes: Record<string, unknown>;
}

type Outcome = "ok" | "error" | "notRun";

/**
 * A fake @zts/qianfan-ocr extractBatch. Records are named as qianfan names
 * them (ocr-<item name>, batch-<batch name>). Item names end in -page for a
 * whole-page read, so answers can differ between the two reads.
 */
function fakeQianfan(options: {
  /** The parsed answer for an item; null for an answer with no JSON. */
  answer?: (name: string) => Record<string, unknown> | null;
  /** Each item's outcome, by name; default ok. */
  outcome?: (name: string) => Outcome;
  /** runModel fails before any item, so nothing is written. */
  fail?: string;
} = {}) {
  const stored: Stored[] = [];
  let batches = 0;
  const runModel = (call: RunModelCall) => {
    if (options.fail) return { ok: false, error: { message: options.fail } };
    batches++;
    const args = call.arguments!;
    const items = args.items as { imagePath: string; name: string }[];
    const handles: Record<string, unknown>[] = [];
    const outcomes = items.map((item) => {
      const status = options.outcome?.(item.name) ?? "ok";
      if (status !== "ok") {
        return {
          status,
          record: null,
          recordVersion: null,
          error: status === "error" ? "the model failed" : null,
        };
      }
      const parsed = options.answer ? options.answer(item.name) : PARSED;
      stored.push({
        modelName: call.definition!,
        name: `ocr-${item.name}`,
        version: 3,
        attributes: {
          parsed,
          rawOutput: parsed ? JSON.stringify(parsed) : "I cannot read this",
          model: "baidu/Qianfan-OCR",
          revision: "abc",
          device: "mps",
        },
      });
      handles.push({ name: `ocr-${item.name}`, specName: "ocr", version: 3 });
      return {
        status,
        record: `ocr-${item.name}`,
        recordVersion: 3,
        error: null,
      };
    });
    stored.push({
      modelName: call.definition!,
      name: `batch-${args.name}`,
      version: 1,
      attributes: { items: outcomes, loadMs: 14000, error: null },
    });
    handles.push({ name: `batch-${args.name}`, specName: "batch", version: 1 });
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
  return { runModel, queryData, batches: () => batches };
}

async function withRepo(body: (repoDir: string) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "home-mail-room-" });
  try {
    await Deno.mkdir(`${repoDir}/Inbound/Incoming`, { recursive: true });
    await body(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
}

const incoming = (repoDir: string, name: string) =>
  `${repoDir}/Inbound/Incoming/${name}`;

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

function contextFor(
  repoDir: string,
  method: string,
  q: ReturnType<typeof fakeQianfan>,
  options: {
    stored?: Record<string, Record<string, unknown>>;
    failWrite?: string;
  } = {},
) {
  const test = createModelTestContext({
    globalArgs: {},
    methodName: method,
    repoDir,
    storedResources: options.stored ?? {},
  });
  const calls: RunModelCall[] = [];
  const context = {
    ...test.context,
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) =>
      specName === options.failWrite
        ? Promise.reject(new Error(`write of ${name} failed`))
        : test.context.writeResource(specName, name, data),
    runModel: (call: RunModelCall) => {
      calls.push(call);
      return Promise.resolve(q.runModel(call));
    },
    queryData: (predicate: string) => Promise.resolve(q.queryData(predicate)),
  };
  return { test, context, calls };
}

/** List Incoming as run r1, then scan its first batch. */
async function scan(
  repoDir: string,
  q = fakeQianfan(),
  args: Record<string, unknown> = {},
  options: Parameters<typeof contextFor>[3] = {},
) {
  const { test, context, calls } = contextFor(repoDir, "scanBatch", q, options);
  // deno-lint-ignore no-explicit-any
  const methods = behavior.methods as any;
  await methods.listIncoming.execute({ run: "r1" }, context);
  let error: Error | null = null;
  try {
    await methods.scanBatch.execute({ list: "r1", batch: 0, ...args }, context);
  } catch (e) {
    error = e as Error;
  }
  const resources = test.getWrittenResources();
  const summary = resources.find((r) => r.specName === "scanBatch")!
    .data as {
      letters: Record<string, unknown>[];
      error: string | null;
    };
  return {
    error,
    summary,
    calls: calls.filter((c) => c.method === "extractBatch"),
    details: resources.filter((r) => r.specName === "details"),
    files: test.getWrittenFiles(),
    logs: test.getLogs().map((l) => JSON.stringify(l)).join("\n"),
  };
}

Deno.test("listIncoming splits Incoming into batches, leaving what maxBatches excludes", async () => {
  await withRepo(async (repoDir) => {
    for (let i = 0; i < 5; i++) {
      await Deno.writeFile(incoming(repoDir, `l${i}.pdf`), SAMPLE);
    }
    const { test, context } = contextFor(
      repoDir,
      "listIncoming",
      fakeQianfan(),
    );
    // deno-lint-ignore no-explicit-any
    await (behavior.methods.listIncoming.execute as any)(
      { run: "r1", batchSize: 2, maxBatches: 2 },
      context,
    );
    const list = test.getWrittenResources()[0];
    assertEquals(list.name, "incoming-r1");
    const data = list.data as {
      total: number;
      waiting: number;
      batches: { index: number; files: { path: string }[] }[];
    };
    assertEquals(data.total, 5);
    assertEquals(data.waiting, 1);
    assertEquals(
      data.batches.map((b) =>
        b.files.map((f) => f.path.slice(f.path.lastIndexOf("/") + 1))
      ),
      [["l0.pdf", "l1.pdf"], ["l2.pdf", "l3.pdf"]],
    );
  });
});

Deno.test("scanBatch reads a letter's top with one extractBatch, records it by content and moves it to ReadyToFile", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "Water Bill.pdf"), SAMPLE);
    const { error, summary, calls, details, files } = await scan(repoDir);

    assertEquals(error, null);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].definition, "qianfan-ocr");
    const items = calls[0].arguments?.items as Record<string, unknown>[];
    assertEquals(items.map((i) => [i.name, i.prompt]), [[
      SHORT,
      DEFAULT_PROMPT,
    ]]);

    assertEquals(details.map((d) => d.name), [`details-${SHORT}`]);
    const d = details[0].data as Record<string, unknown>;
    assertEquals(d.sender, "Fenwick Valley Water");
    assertEquals(d.documentType, "statement");
    assertEquals(d.contentHash, HASH);
    assertEquals(d.originalName, "Water Bill.pdf");
    assertEquals(d.fraction, 0.25);
    assertEquals(files.map((f) => f.name), [`header-${SHORT}`]);

    const moved = `${repoDir}/Inbound/ReadyToFile/Water Bill.pdf`;
    assertEquals(await exists(moved), true);
    assertEquals(await exists(incoming(repoDir, "Water Bill.pdf")), false);
    assertEquals(summary.letters[0].status, "read");
    assertEquals(summary.letters[0].movedTo, moved);
  });
});

Deno.test("scanBatch reads the whole page of a letter whose top showed no sender, with a second extractBatch", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const q = fakeQianfan({
      answer: (name) =>
        name.endsWith("-page") ? PARSED : { ...PARSED, sender: null },
    });
    const { summary, calls, details } = await scan(repoDir, q);

    assertEquals(calls.length, 2);
    const second = calls[1].arguments?.items as Record<string, unknown>[];
    assertEquals(second.map((i) => i.name), [`${SHORT}-page`]);
    const d = details[0].data as Record<string, unknown>;
    assertEquals(d.sender, "Fenwick Valley Water");
    assertEquals(d.fraction, 1);
    assertEquals(summary.letters[0].fullPage, true);
    assertEquals(summary.letters[0].status, "read");
  });
});

Deno.test("scanBatch keeps the top's answer when the whole page's held no JSON", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const q = fakeQianfan({
      answer: (name) =>
        name.endsWith("-page") ? null : { ...PARSED, date: null },
    });
    const { summary, details } = await scan(repoDir, q);
    const d = details[0].data as Record<string, unknown>;
    assertEquals([d.parsedOk, d.fraction, d.date], [true, 0.25, null]);
    // Missing a date is for a person to settle, not a failure.
    assertEquals(summary.letters[0].status, "read");
    assertEquals(await exists(`${repoDir}/Inbound/ReadyToFile/a.pdf`), true);
  });
});

Deno.test("scanBatch reads only the top when retryFullPage is off", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const q = fakeQianfan({ answer: () => ({ ...PARSED, sender: null }) });
    const { calls } = await scan(repoDir, q, { retryFullPage: false });
    assertEquals(calls.length, 1);
  });
});

Deno.test("scanBatch moves a file that is not a PDF to Failed without sending it to the model", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(
      incoming(repoDir, "junk.pdf"),
      new TextEncoder().encode("not a pdf"),
    );
    const { error, summary, calls } = await scan(repoDir);
    assertEquals(error, null);
    assertEquals(calls.length, 0);
    assertEquals(summary.letters[0].status, "unreadable");
    assertEquals(await exists(`${repoDir}/Inbound/Failed/junk.pdf`), true);
  });
});

Deno.test("scanBatch moves a letter to Failed when neither read gave JSON, keeping what was read", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const { summary, details } = await scan(
      repoDir,
      fakeQianfan({ answer: () => null }),
    );
    assertEquals(summary.letters[0].status, "unreadable");
    assertEquals((details[0].data as Record<string, unknown>).parsedOk, false);
    assertEquals(await exists(`${repoDir}/Inbound/Failed/a.pdf`), true);
  });
});

Deno.test("scanBatch moves a letter the model failed on twice to Failed", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const { summary, calls } = await scan(
      repoDir,
      fakeQianfan({ outcome: () => "error" }),
    );
    assertEquals(calls.length, 2);
    assertEquals(summary.letters[0].status, "unreadable");
    assertEquals(summary.letters[0].error, "the model failed");
    assertEquals(await exists(`${repoDir}/Inbound/Failed/a.pdf`), true);
  });
});

Deno.test("scanBatch leaves letters in Incoming and fails, after recording why, when the model cannot run", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const { error, summary } = await scan(
      repoDir,
      fakeQianfan({ fail: "no such behavior" }),
    );
    assertStringIncludes(
      error!.message,
      "swamp behavior create @zts/qianfan-ocr",
    );
    assertStringIncludes(summary.error!, "no such behavior");
    assertEquals(summary.letters[0].status, "notRun");
    assertEquals(await exists(incoming(repoDir, "a.pdf")), true);
  });
});

Deno.test("scanBatch does not read a letter again that was read before; it moves it on", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "again.pdf"), SAMPLE);
    const { summary, calls } = await scan(repoDir, fakeQianfan(), {}, {
      stored: { [`details-${SHORT}`]: { contentHash: HASH } },
    });
    assertEquals(calls.length, 0);
    assertEquals(summary.letters[0].status, "known");
    assertEquals(
      await exists(`${repoDir}/Inbound/ReadyToFile/again.pdf`),
      true,
    );
  });
});

Deno.test("scanBatch names each letter it did not read again, and when it was read", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "again.pdf"), SAMPLE);
    const readAt = "2026-11-06T15:23:22.983Z";
    const { summary, logs } = await scan(repoDir, fakeQianfan(), {}, {
      stored: {
        [`details-${SHORT}`]: { contentHash: HASH, scannedAt: readAt },
      },
    });
    assertEquals(summary.letters[0].readBefore, readAt);
    assertStringIncludes(logs, "again.pdf");
    assertStringIncludes(logs, readAt);
  });
});

Deno.test("scanBatch reads two copies of a letter once and moves both", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    await Deno.writeFile(incoming(repoDir, "b.pdf"), SAMPLE);
    const { summary, calls } = await scan(repoDir);
    assertEquals(
      (calls[0].arguments?.items as unknown[]).length,
      1,
    );
    assertEquals(summary.letters.map((l) => l.status), ["read", "read"]);
    assertEquals(await exists(`${repoDir}/Inbound/ReadyToFile/a.pdf`), true);
    assertEquals(await exists(`${repoDir}/Inbound/ReadyToFile/b.pdf`), true);
  });
});

Deno.test("scanBatch skips a listed letter that left Incoming and reads the rest", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    await Deno.writeFile(
      incoming(repoDir, "gone.pdf"),
      new TextEncoder().encode("x"),
    );
    const q = fakeQianfan();
    const { test, context } = contextFor(repoDir, "scanBatch", q);
    // deno-lint-ignore no-explicit-any
    const methods = behavior.methods as any;
    await methods.listIncoming.execute({ run: "r1" }, context);
    await Deno.remove(incoming(repoDir, "gone.pdf"));
    await methods.scanBatch.execute({ list: "r1", batch: 0 }, context);
    const summary = test.getWrittenResources().find((r) =>
      r.specName === "scanBatch"
    )!.data as { letters: { status: string }[] };
    assertEquals(summary.letters.map((l) => l.status), ["read", "gone"]);
  });
});

Deno.test("scanBatch leaves a letter in Incoming when its details cannot be written", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const { test, context } = contextFor(repoDir, "scanBatch", fakeQianfan(), {
      failWrite: "details",
    });
    // deno-lint-ignore no-explicit-any
    const methods = behavior.methods as any;
    await methods.listIncoming.execute({ run: "r1" }, context);
    await assertRejects(
      () => methods.scanBatch.execute({ list: "r1", batch: 0 }, context),
      Error,
      "left in Incoming",
    );
    assertEquals(await exists(incoming(repoDir, "a.pdf")), true);
    assertEquals(test.getWrittenFiles().length, 0);
  });
});

Deno.test("scanBatch keeps the letters' contents out of its logs", async () => {
  await withRepo(async (repoDir) => {
    await Deno.writeFile(incoming(repoDir, "a.pdf"), SAMPLE);
    const { logs } = await scan(repoDir);
    assertEquals(logs.includes("Fenwick"), false);
  });
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
