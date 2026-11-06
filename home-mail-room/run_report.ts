/**
 * Sums up one process-incoming run: what the scanner did with each letter in
 * Incoming, batch by batch, and what the filer then did with each letter in
 * ReadyToFile. It reads the records the run's steps wrote: incoming-<run>,
 * scan-batch-<run>-<n> and file-ready. Records are found by name, not by the
 * step's handles, as a batch that fails still writes its record and then
 * throws.
 *
 *   swamp report get @zts/home-mail-room/run-summary \
 *     --workflow @zts/home-mail-room/process-incoming
 *
 * @module
 */
import type { Run } from "./filer.ts";

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface Step {
  stepName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  methodArgs: Record<string, unknown>;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
}

interface Context {
  workflowRunId: string;
  workflowStatus: string;
  stepExecutions: Step[];
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

interface IncomingList {
  total: number;
  waiting: number;
  batches: { index: number; files: { path: string; hash: string }[] }[];
}

interface ScanBatch {
  letters: {
    path: string;
    status: "read" | "known" | "unreadable" | "gone" | "notRun" | "error";
    fullPage: boolean;
    error: string | null;
    /** When a known letter was read; absent from records before it. */
    readBefore?: string | null;
  }[];
  error: string | null;
}

export interface Row {
  letter: string;
  result: string;
  notes: string;
}

/** The scanner's outcomes, as the report words them. */
const SCANNED: Record<ScanBatch["letters"][number]["status"], string> = {
  read: "Read, to ReadyToFile",
  known: "Read before, to ReadyToFile",
  unreadable: "Unreadable, to Failed",
  gone: "Gone from Incoming",
  notRun: "Left in Incoming",
  error: "Left in Incoming",
};

/** The filer's outcomes, as the reports word them. */
const FILED: Record<Run["letters"][number]["outcome"], string> = {
  filed: "Filed",
  held: "Held for review",
  conflict: "Held: destination taken",
  skipped: "Skipped",
  duplicate: "Copy of a filed letter, to Archived",
  waiting: "Held: a decision could not be applied",
  dropped: "Record dropped",
  refused: "Refused",
};

async function read<T>(
  context: Context,
  step: Step,
  name: string,
  version?: number,
): Promise<T | null> {
  const bytes = await context.dataRepository.getContent(
    step.modelType,
    step.modelId,
    name,
    version,
  );
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as T : null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A cabinet file as <Sender>/<file name>. */
export function cabinetName(path: string): string {
  return path.split("/").slice(-2).join("/");
}

export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

export function table(rows: Row[], notes: string): string {
  return [
    `| Letter | Result | ${notes} |`,
    "| --- | --- | --- |",
    ...rows.map((r) =>
      `| ${cell(r.letter)} | ${cell(r.result)} | ${cell(r.notes)} |`
    ),
  ].join("\n");
}

/** A filer run's letters as table rows. */
export function filerRows(
  letters: Run["letters"],
): (Row & { outcome: string })[] {
  return letters.map((l) => ({
    letter: l.originalName || l.letter,
    outcome: l.outcome,
    result: FILED[l.outcome],
    notes: [
      l.destination ? cabinetName(l.destination) : "",
      ...l.reasons,
    ].filter(Boolean).join("; "),
  }));
}

function tally<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const report = {
  name: "@zts/home-mail-room/run-summary",
  description:
    "What a process-incoming run did with each letter: read, failed or left in Incoming, then filed or held for review",
  scope: "workflow" as const,
  labels: ["mail"],
  execute: async (context: Context) => {
    const run = context.workflowRunId;
    const lister = context.stepExecutions.find((s) =>
      s.methodName === "listIncoming"
    );
    const list = lister
      ? await read<IncomingList>(context, lister, `incoming-${run}`)
      : null;
    const problems: string[] = [];
    if (!list) problems.push("Incoming was not listed, so nothing was read");

    const scanRows: (Row & { status: string })[] = [];
    for (const batch of list?.batches ?? []) {
      const record = await read<ScanBatch>(
        context,
        lister!,
        `scan-batch-${run}-${batch.index}`,
      );
      if (!record) {
        problems.push(
          `Batch ${batch.index} stopped before recording anything; its letters are still in Incoming`,
        );
        for (const f of batch.files) {
          scanRows.push({
            letter: baseName(f.path),
            status: "notRun",
            result: SCANNED.notRun,
            notes: "",
          });
        }
        continue;
      }
      if (record.error) {
        problems.push(`Batch ${batch.index}: ${record.error}`);
      }
      for (const l of record.letters) {
        scanRows.push({
          letter: baseName(l.path),
          status: l.status,
          result: SCANNED[l.status],
          notes: [
            l.status === "known"
              ? `not read again; read at ${l.readBefore ?? "an unknown time"}`
              : "",
            l.fullPage ? "read the whole page" : "",
            l.error ?? "",
          ].filter(Boolean).join("; "),
        });
      }
    }

    const filer = context.stepExecutions.find((s) =>
      s.methodName === "fileReady"
    );
    const handle = filer?.dataHandles.find((h) => h.name === "file-ready");
    const filing = filer && handle
      ? await read<Run>(context, filer, handle.name, handle.version)
      : null;
    if (!filing) {
      problems.push(
        filer?.status === "failed"
          ? "The file step failed; letters in ReadyToFile wait for the next run"
          : "The file step did not run; letters in ReadyToFile wait for the next run",
      );
    }
    const fileRows = filerRows(filing?.letters ?? []);

    const scanned = tally(scanRows.map((r) => r.status));
    const filed = tally(fileRows.map((r) => r.outcome));
    const left = (scanned.notRun ?? 0) + (scanned.error ?? 0);
    const held = (filed.held ?? 0) + (filed.conflict ?? 0) +
      (filed.waiting ?? 0);

    const lines = [
      `# Mail room run ${run.slice(0, 8)}: ${context.workflowStatus}`,
      "",
    ];
    if (problems.length) {
      lines.push(...problems.map((p) => `- **${p}**`), "");
    }
    if (scanRows.length === 0) {
      lines.push("Incoming was empty.");
    } else {
      lines.push(
        `Scanned ${plural(scanRows.length, "letter")} in ${
          plural(list!.batches.length, "batch", "batches")
        }: ${scanned.read ?? 0} read, ${scanned.known ?? 0} read before, ${
          scanned.unreadable ?? 0
        } to Failed, ${left} left in Incoming.`,
      );
      const known = scanRows.filter((r) => r.status === "known");
      if (known.length) {
        lines.push(`Not read again: ${known.map((r) => r.letter).join(", ")}.`);
      }
    }
    if (list?.waiting) {
      lines.push(`${plural(list.waiting, "letter")} wait for a later run.`);
    }
    if (filing) {
      lines.push(
        fileRows.length === 0
          ? "ReadyToFile was empty."
          : `Filed ${filed.filed ?? 0}, held ${held} for review, archived ${
            filed.duplicate ?? 0
          } ${filed.duplicate === 1 ? "copy" : "copies"}.`,
      );
    }
    if (held > 0) {
      lines.push(
        "",
        "Review the held letters with `swamp behavior run review serve`.",
      );
    }
    if (scanRows.length) {
      lines.push("", "## Scanned", "", table(scanRows, "Notes"));
    }
    if (fileRows.length) {
      lines.push("", "## Filed", "", table(fileRows, "Where, or why not"));
    }

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        run,
        status: context.workflowStatus,
        problems,
        waitingInIncoming: list?.waiting ?? 0,
        scanned: { counts: scanned, letters: scanRows },
        filed: { counts: filed, letters: fileRows },
      },
    };
  },
};
