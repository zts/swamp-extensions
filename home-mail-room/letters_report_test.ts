import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { report } from "./letters_report.ts";

const CABINET = "/repo/FileCabinet";

/** The filer after a run that wrote the given run record. */
function context(
  letters: Record<string, Record<string, unknown>>,
  run: { name: string; letters: Record<string, unknown>[] } | null,
  method = run?.name === "decisions" ? "decide" : "fileReady",
) {
  const records: Record<string, unknown> = { ...letters };
  if (run) records[run.name] = { letters: run.letters };
  return {
    modelType: "@zts/home-mail-room/filer",
    modelId: "flr",
    methodName: method,
    executionStatus: "succeeded" as const,
    definition: { name: "filer" },
    globalArgs: { retention: "30d" },
    dataHandles: run ? [{ name: run.name, specName: "run", version: 2 }] : [],
    dataRepository: {
      getContent: (_t: string, _m: string, name: string) =>
        Promise.resolve(
          name in records
            ? new TextEncoder().encode(JSON.stringify(records[name]))
            : null,
        ),
      // Every version of a record is listed.
      findAllForModel: () =>
        Promise.resolve(
          Object.keys(records).flatMap((name) => [{ name }, { name }]),
        ),
    },
  };
}

const letter = (
  originalName: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  originalName,
  state,
  reasons: [],
  updatedAt: "2026-11-01T10:00:00Z",
  ...extra,
});

Deno.test("the letters report shows what a decide run did, as a person decided it", async () => {
  const result = await report.execute(context({
    "letter-a": letter("a.pdf", "filed", {
      destination: `${CABINET}/Acme/2026-01-02 Acme bill.pdf`,
      decision: { decidedAt: "2026-11-06T16:00:00Z" },
    }),
  }, {
    name: "decisions",
    letters: [{
      letter: "letter-a",
      originalName: "a.pdf",
      outcome: "filed",
      by: "person",
      destination: `${CABINET}/Acme/2026-01-02 Acme bill.pdf`,
      reasons: [],
    }],
  }));
  assertStringIncludes(result.markdown, "## This decide run");
  assertStringIncludes(
    result.markdown,
    "| a.pdf | Filed | Acme/2026-01-02 Acme bill.pdf |",
  );
  assertStringIncludes(
    result.markdown,
    "| 2026-11-06 16:00 | a.pdf | Filed | person | Acme/2026-01-02 Acme bill.pdf |",
  );
});

Deno.test("the letters report lists letters waiting for review, with why", async () => {
  const result = await report.execute(context({
    "letter-b": letter("b.pdf", "held", { reasons: ["No date was read"] }),
    "letter-c": letter("c.pdf", "conflict", {
      reasons: ["Another file is already at X"],
    }),
  }, { name: "file-ready", letters: [] }));
  assertStringIncludes(result.markdown, "## Waiting for review (2)");
  assertStringIncludes(result.markdown, "| b.pdf | Held | No date was read |");
  assertStringIncludes(
    result.markdown,
    "| c.pdf | Destination taken | Another file is already at X |",
  );
  assertStringIncludes(result.markdown, "It found no letters to act on.");
  assertEquals(result.json.waiting.length, 2);
});

Deno.test("the letters report lists filed and skipped letters newest first, and who decided", async () => {
  const result = await report.execute(context({
    "letter-old": letter("old.pdf", "filed", {
      destination: `${CABINET}/Acme/old.pdf`,
      updatedAt: "2026-10-01T10:00:00Z",
    }),
    "letter-new": letter("new.pdf", "skipped", {
      decision: { decidedAt: "2026-11-05T10:00:00Z" },
    }),
  }, null));
  assertEquals(
    result.json.done.map((d) => [d.originalName, d.by]),
    [["new.pdf", "person"], ["old.pdf", "filer"]],
  );
  assertStringIncludes(
    result.markdown,
    "| 2026-11-05 10:00 | new.pdf | Skipped | person |  |",
  );
  assertStringIncludes(result.markdown, "kept for 30d");
});

Deno.test("the letters report says when the run failed", async () => {
  const c = {
    ...context({}, null),
    executionStatus: "failed" as const,
    errorMessage: "disk full",
  };
  const result = await report.execute(c);
  assertStringIncludes(result.markdown, "**It failed: disk full**");
  assertStringIncludes(result.markdown, "None in the last 30d.");
});
