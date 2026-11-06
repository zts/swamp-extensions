import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./run_report.ts";

const RUN = "9d329e29-5161-4112-80bb-af325553d693";
const IN = "/repo/Inbound/Incoming";
const CABINET = "/repo/FileCabinet";

type Status = "succeeded" | "failed" | "skipped";

/** A finished run whose steps wrote the given records. */
function context(
  records: Record<string, unknown>,
  steps: { scan?: Status[]; file?: Status | null } = {},
) {
  const scanner = { modelType: "@zts/home-mail-room/scanner", modelId: "scn" };
  const filer = { modelType: "@zts/home-mail-room/filer", modelId: "flr" };
  const step = (
    model: { modelType: string; modelId: string },
    stepName: string,
    methodName: string,
    status: Status,
    names: string[] = [],
  ) => ({
    ...model,
    stepName,
    methodName,
    methodArgs: {},
    status,
    dataHandles: names.filter((n) => n in records).map((name) => ({
      name,
      version: 3,
    })),
  });
  return {
    workflowRunId: RUN,
    workflowStatus: "succeeded",
    stepExecutions: [
      step(scanner, "list-incoming", "listIncoming", "succeeded", [
        `incoming-${RUN}`,
      ]),
      ...(steps.scan ?? []).map((status, i) =>
        step(scanner, `batch-${i}`, "scanBatch", status)
      ),
      ...(steps.file === null
        ? []
        : [step(filer, "file-ready", "fileReady", steps.file ?? "succeeded", [
          "file-ready",
        ])]),
    ],
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        name: string,
        _version?: number,
      ) =>
        Promise.resolve(
          name in records
            ? new TextEncoder().encode(JSON.stringify(records[name]))
            : null,
        ),
    },
  };
}

const list = (...batches: string[][]) => ({
  [`incoming-${RUN}`]: {
    total: batches.flat().length,
    waiting: 0,
    batches: batches.map((files, index) => ({
      index,
      files: files.map((f) => ({ path: `${IN}/${f}`, hash: f })),
    })),
  },
});

const scanned = (
  letters: [string, string, string?][],
  error: string | null = null,
) => ({
  letters: letters.map(([name, status, problem]) => ({
    path: `${IN}/${name}`,
    status,
    fullPage: false,
    error: problem ?? null,
  })),
  error,
});

const filed = (
  letters: [string, string, string | null, string[]][],
) => ({
  "file-ready": {
    method: "fileReady",
    letters: letters.map(([originalName, outcome, destination, reasons]) => ({
      letter: "letter-0123456789abcdef",
      originalName,
      outcome,
      by: "filer",
      destination,
      reasons,
    })),
    finishedAt: "2026-11-06T16:00:00Z",
  },
});

Deno.test("a run's summary counts what was read and filed, and lists each letter", async () => {
  const result = await report.execute(context({
    ...list(["a.pdf", "b.pdf", "c.pdf"]),
    [`scan-batch-${RUN}-0`]: scanned([
      ["a.pdf", "read"],
      ["b.pdf", "known"],
      ["c.pdf", "unreadable", "Not a PDF"],
    ]),
    ...filed([
      [
        "a.pdf",
        "filed",
        `${CABINET}/Thames Water/2023-05-18 Thames Water bill.pdf`,
        [],
      ],
      ["b.pdf", "held", null, ['No FileCabinet folder for the sender "Acme"']],
    ]),
  }, { scan: ["succeeded"] }));

  assertStringIncludes(
    result.markdown,
    "Scanned 3 letters in 1 batch: 1 read, 1 read before, 1 to Failed, 0 left in Incoming.",
  );
  assertStringIncludes(
    result.markdown,
    "Filed 1, held 1 for review, archived 0 copies.",
  );
  assertStringIncludes(
    result.markdown,
    "| c.pdf | Unreadable, to Failed | Not a PDF |",
  );
  assertStringIncludes(
    result.markdown,
    "| a.pdf | Filed | Thames Water/2023-05-18 Thames Water bill.pdf |",
  );
  assertStringIncludes(
    result.markdown,
    '| b.pdf | Held for review | No FileCabinet folder for the sender "Acme" |',
  );
  assertStringIncludes(result.markdown, "swamp behavior run review serve");
  assertEquals(result.json.problems, []);
  assertEquals(result.json.filed.counts, { filed: 1, held: 1 });
});

Deno.test("a run names the letters it did not read again, and when they were read", async () => {
  const batch = scanned([["a.pdf", "read"], ["b.pdf", "known"]]);
  Object.assign(batch.letters[1], { readBefore: "2026-11-06T15:23:22.983Z" });
  const result = await report.execute(context({
    ...list(["a.pdf", "b.pdf"]),
    [`scan-batch-${RUN}-0`]: batch,
  }, { scan: ["succeeded"], file: null }));

  assertStringIncludes(result.markdown, "Not read again: b.pdf.");
  assertStringIncludes(
    result.markdown,
    "| b.pdf | Read before, to ReadyToFile | not read again; read at 2026-11-06T15:23:22.983Z |",
  );
});

Deno.test("a batch the model could not read leaves its letters in Incoming, with the error", async () => {
  const result = await report.execute(context({
    ...list(["a.pdf"]),
    [`scan-batch-${RUN}-0`]: scanned([["a.pdf", "notRun"]], "Model OOM"),
    ...filed([]),
  }, { scan: ["failed"] }));
  assertStringIncludes(result.markdown, "**Batch 0: Model OOM**");
  assertStringIncludes(result.markdown, "| a.pdf | Left in Incoming |  |");
  assertStringIncludes(result.markdown, "1 left in Incoming");
});

Deno.test("a batch that stopped before recording lists its letters as left in Incoming", async () => {
  const result = await report.execute(context({
    ...list(["a.pdf"], ["b.pdf"]),
    [`scan-batch-${RUN}-0`]: scanned([["a.pdf", "read"]]),
    ...filed([]),
  }, { scan: ["succeeded", "failed"] }));
  assertEquals(result.json.problems, [
    "Batch 1 stopped before recording anything; its letters are still in Incoming",
  ]);
  assertStringIncludes(result.markdown, "| b.pdf | Left in Incoming |  |");
});

Deno.test("a run says when the file step did not file anything", async () => {
  const failed = await report.execute(
    context(list(), { file: "failed" }),
  );
  assertStringIncludes(
    failed.markdown,
    "The file step failed; letters in ReadyToFile wait for the next run",
  );
  const skipped = await report.execute(context(list(), { file: null }));
  assertStringIncludes(skipped.markdown, "The file step did not run");
});

Deno.test("an empty run says there was nothing to do", async () => {
  const result = await report.execute(context({ ...list(), ...filed([]) }));
  assertStringIncludes(result.markdown, "Incoming was empty.");
  assertStringIncludes(result.markdown, "ReadyToFile was empty.");
  assertEquals(result.markdown.includes("## "), false);
});

Deno.test("a letter's name cannot break the table", async () => {
  const result = await report.execute(context({
    ...list(["a|b.pdf"]),
    [`scan-batch-${RUN}-0`]: scanned([["a|b.pdf", "read"]]),
    ...filed([]),
  }));
  assertStringIncludes(result.markdown, "| a\\|b.pdf | Read, to ReadyToFile |");
});
