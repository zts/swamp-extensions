/**
 * The filer's letters after each of its runs: what this run did, the letters
 * waiting for a person, and the letters filed or skipped, newest first, with
 * who decided each. It runs after every fileReady and every decide, and the
 * review page's decisions are decide runs, so its latest version is a log of
 * what the review page did as well.
 *
 *   swamp report get @zts/home-mail-room/letters --behavior filer
 *
 * @module
 */
import type { Run } from "./filer.ts";
import { cabinetName, cell, filerRows, type Row, table } from "./run_report.ts";

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface Context {
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  definition: { name: string };
  globalArgs: Record<string, unknown>;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
    findAllForModel(type: string, modelId: string): Promise<{ name: string }[]>;
  };
}

/** The parts of a filer letter record the report shows. */
interface Letter {
  state: "held" | "conflict" | "filed" | "skipped";
  originalName: string;
  destination?: string;
  reasons: string[];
  decision?: { decidedAt?: string };
  updatedAt: string;
}

async function read<T>(
  context: Context,
  name: string,
  version?: number,
): Promise<T | null> {
  const bytes = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    name,
    version,
  );
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as T : null;
}

/** An ISO time to the minute, in UTC as recorded. */
function minute(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** The letter's latest record, by name; a name may have several versions. */
async function letters(context: Context): Promise<Letter[]> {
  const names = new Set(
    (await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    )).map((d) => d.name).filter((n) => n.startsWith("letter-")),
  );
  const result: Letter[] = [];
  for (const name of names) {
    const letter = await read<Letter>(context, name);
    if (letter) result.push(letter);
  }
  return result;
}

export const report = {
  name: "@zts/home-mail-room/letters",
  description:
    "The filer's letters: what its last run did, which wait for review, and which were filed or skipped, by whom",
  scope: "model" as const,
  labels: ["mail"],
  execute: async (context: Context) => {
    const handle = context.dataHandles.find((h) =>
      h.name === "file-ready" || h.name === "decisions" || h.name === "renames"
    );
    const run = handle
      ? await read<Run>(context, handle.name, handle.version)
      : null;
    const runRows = filerRows(run?.letters ?? []);

    const all = await letters(context);
    const open = all.filter((l) => l.state === "held" || l.state === "conflict")
      .sort((a, b) => a.originalName.localeCompare(b.originalName));
    const done = all.filter((l) => l.state === "filed" || l.state === "skipped")
      .map((l) => ({
        ...l,
        at: l.decision?.decidedAt ?? l.updatedAt,
        by: l.decision ? "person" : "filer",
      }))
      .sort((a, b) => b.at.localeCompare(a.at));

    const lines = [
      `# Letters: ${context.definition.name}`,
      "",
      `## This ${context.methodName} run`,
      "",
    ];
    if (context.executionStatus === "failed") {
      lines.push(`**It failed: ${context.errorMessage ?? "no reason given"}**`);
    } else if (runRows.length === 0) {
      lines.push("It found no letters to act on.");
    } else {
      lines.push(table(runRows, "Where, or why not"));
    }

    lines.push("", `## Waiting for review (${open.length})`, "");
    if (open.length === 0) {
      lines.push("None.");
    } else {
      lines.push(
        table(
          open.map((l): Row => ({
            letter: l.originalName,
            result: l.state === "conflict" ? "Destination taken" : "Held",
            notes: l.reasons.join("; "),
          })),
          "Why",
        ),
        "",
        "Review them with `swamp behavior run review serve`.",
      );
    }

    const retention = context.globalArgs.retention ?? "30d";
    lines.push("", `## Filed and skipped (${done.length})`, "");
    if (done.length === 0) {
      lines.push(`None in the last ${retention}.`);
    } else {
      lines.push(
        "| When (UTC) | Letter | Result | By | Where |",
        "| --- | --- | --- | --- | --- |",
        ...done.map((l) =>
          `| ${minute(l.at)} | ${cell(l.originalName)} | ${
            l.state === "filed" ? "Filed" : "Skipped"
          } | ${l.by} | ${
            l.destination && l.state === "filed"
              ? cell(cabinetName(l.destination))
              : ""
          } |`
        ),
        "",
        `Records are kept for ${retention} after a letter is filed or skipped.`,
      );
    }

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        method: context.methodName,
        status: context.executionStatus,
        run: runRows,
        waiting: open.map((l) => ({
          originalName: l.originalName,
          state: l.state,
          reasons: l.reasons,
        })),
        done: done.map((l) => ({
          originalName: l.originalName,
          state: l.state,
          by: l.by,
          at: l.at,
          destination: l.state === "filed" ? l.destination ?? null : null,
        })),
      },
    };
  },
};
