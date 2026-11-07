/**
 * Files the letters waiting in Inbound/ReadyToFile into the FileCabinet. One
 * instance holds every letter as a `letter-<short hash>` record.
 *
 * fileReady reviews every letter in ReadyToFile with what the scanner read
 * off it, and files each one it can on its own: a copy goes into the
 * cabinet's sender folder and the original into Archived. The rest are held
 * there for a person, who files or skips them through decide; a skipped
 * letter moves to Skipped. The folder a letter is in is the truth: a letter
 * put back into ReadyToFile is reviewed again.
 *
 * A sender is proposed under the name the cabinet's senders.yaml gives it,
 * if any; renameSender adds to that list and re-reviews the open letters
 * from that sender.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  cleanSegment,
  destinationPath,
  DOCUMENT_TYPES,
  filenameProblem,
  type FilingFields,
  matchSender,
  parseLetterDate,
  senderKey,
  senderName,
} from "./filing.ts";
import {
  fileHash,
  folder,
  movedTo,
  moveInto,
  type Pdf,
  pdfsIn,
  resolve,
  shortHash,
} from "./inbound.ts";
import { addSenderNames, readSenderNames } from "./senders.ts";

const NAME = /^[A-Za-z0-9_-]+$/;

const GlobalArgsSchema = z.object({
  scanner: z.string().regex(NAME).default("scanner").describe(
    "The @zts/home-mail-room/scanner instance that reads the letters",
  ),
  inboundDir: z.string().min(1).default("Inbound").describe(
    "Folder holding ReadyToFile, Archived and Skipped; absolute, or relative to the repository",
  ),
  cabinetDir: z.string().min(1).default("FileCabinet").describe(
    "Folder of sender folders letters are filed into; absolute, or relative to the repository",
  ),
  retention: z.string().min(1).default("30d").describe(
    "How long a filed or skipped letter's record is kept",
  ),
});

type Globals = z.infer<typeof GlobalArgsSchema>;

const DecisionSchema = z.object({
  letter: z.string().regex(/^letter-[0-9a-f]{16}$/),
  action: z.enum(["file", "skip"]),
  sender: z.string().optional(),
  date: z.string().optional(),
  documentType: z.string().optional(),
  title: z.string().optional(),
  filename: z.string().optional(),
  overwrite: z.boolean().default(false).describe(
    "Replace another file already at the destination",
  ),
});

const DecideArgsSchema = z.object({
  decisions: z.array(DecisionSchema).min(1),
});

const RenameArgsSchema = z.object({
  letters: z.array(z.string().regex(/^letter-[0-9a-f]{16}$/)).min(1).describe(
    "Letters whose sender is renamed, with every open letter whose sender was read the same way",
  ),
  sender: z.string().describe("How the sender is written from now on"),
});

/** The states a person may still decide a letter in. */
const OPEN = new Set(["held", "conflict"]);

const STATES = ["held", "conflict", "filed", "skipped"] as const;

const ProposalSchema = z.object({
  sender: z.string(),
  date: z.string().describe("ISO date, or empty when it could not be read"),
  documentType: z.enum(DOCUMENT_TYPES),
  title: z.string(),
  filename: z.string().optional(),
});

const LetterSchema = z.object({
  state: z.enum(STATES),
  pdfPath: z.string().describe("Where the letter's file is now"),
  originalName: z.string(),
  contentHash: z.string().describe("SHA-256 of the PDF, in hex"),
  cabinetDir: z.string().describe("The cabinet it is filed into"),
  extracted: z.record(z.string(), z.unknown()).describe(
    "What the scanner read off the letter, unchanged",
  ),
  proposal: ProposalSchema,
  reasons: z.array(z.string()).describe("Why the letter is held"),
  decision: z.record(z.string(), z.unknown()).optional(),
  destination: z.string().optional(),
  archivedPath: z.string().optional().describe(
    "Where the original went: into Archived, or Skipped",
  ),
  updatedAt: z.string(),
});

type Letter = z.infer<typeof LetterSchema>;
type Proposal = z.infer<typeof ProposalSchema>;

const OUTCOMES = [
  ...STATES,
  "duplicate",
  "waiting",
  "dropped",
  "refused",
] as const;

/** What one fileReady or decide run did to each letter it looked at. */
export const RunSchema = z.object({
  method: z.enum(["fileReady", "decide", "renameSender"]),
  letters: z.array(z.object({
    letter: z.string(),
    originalName: z.string().describe("The file's name in ReadyToFile"),
    outcome: z.enum(OUTCOMES).describe(
      "The letter's state after the run; duplicate: a copy of a filed " +
        "letter, moved to Archived; waiting: a person's decision that " +
        "could not be applied; dropped: its file left ReadyToFile without " +
        "a decision; refused: a decision for a letter that was not open",
    ),
    by: z.enum(["filer", "person"]).describe("Who decided what to do"),
    destination: z.string().nullable().describe(
      "The cabinet file it was filed as, is a copy of, or conflicts with",
    ),
    reasons: z.array(z.string()).describe("Why it is held or was refused"),
  })),
  finishedAt: z.string(),
});

export type Run = z.infer<typeof RunSchema>;
type Outcome = Run["letters"][number];

/** A letter's outcome, from its state after the run. */
function outcomeOf(letter: Letter, by: Outcome["by"]): Outcome {
  return {
    letter: letterId(letter.contentHash),
    originalName: letter.originalName,
    outcome: letter.state,
    by,
    destination: letter.state === "filed" || letter.state === "conflict"
      ? letter.destination ?? null
      : null,
    reasons: letter.reasons,
  };
}

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface DataRecord {
  name: string;
  version?: number;
  modelId?: string;
  modelType?: string;
  attributes?: Record<string, unknown>;
}

interface Context {
  globalArgs: z.input<typeof GlobalArgsSchema>;
  repoDir: string;
  modelType: string;
  modelId: string;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { lifetime?: string },
  ): Promise<DataHandle>;
  createFileWriter(
    specName: string,
    name: string,
    overrides?: { lifetime?: string },
  ): { writeAll(content: Uint8Array): Promise<DataHandle> };
  deleteResource(name: string): Promise<void>;
  queryData(predicate: string): Promise<unknown[]>;
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
    ): Promise<Uint8Array | null>;
    findAllForModel(type: string, modelId: string): Promise<{ name: string }[]>;
  };
}

/** A letter's id, from its content hash: its record is named after it. */
export function letterId(hash: string): string {
  return `letter-${shortHash(hash)}`;
}

function headerName(hash: string): string {
  return `header-${shortHash(hash)}`;
}

/** The latest version of each record, by name. */
function latestByName(records: DataRecord[]): Map<string, DataRecord> {
  const latest = new Map<string, DataRecord>();
  for (const r of records) {
    const seen = latest.get(r.name);
    if (!seen || (r.version ?? 0) > (seen.version ?? 0)) latest.set(r.name, r);
  }
  return latest;
}

/** The sender folders already in the cabinet. */
async function cabinetFolders(cabinetDir: string): Promise<string[]> {
  const folders: string[] = [];
  try {
    for await (const entry of Deno.readDir(cabinetDir)) {
      if (entry.isDirectory) folders.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return folders;
}

/** The sender as read off a letter, cleaned; empty when none was read. */
function readSender(details: Record<string, unknown>): string {
  return cleanSegment(typeof details.sender === "string" ? details.sender : "");
}

/**
 * How to file a letter, and why it cannot be filed without a person. A
 * sender the cabinet renames is proposed as written there.
 */
function review(
  details: Record<string, unknown>,
  folders: string[],
  renames: Map<string, string>,
): { proposal: Proposal; reasons: string[] } {
  const reasons: string[] = [];
  if (details.parsedOk === false) {
    reasons.push("The OCR answer was not readable");
  }
  const rawSender = readSender(details);
  const sender = renames.get(senderKey(rawSender)) ?? senderName(rawSender);
  const folder = matchSender(sender, folders);
  if (!sender) reasons.push("No sender was read");
  else if (!folder) {
    reasons.push(`No FileCabinet folder for the sender "${sender}"`);
  }
  const rawDate = typeof details.date === "string" ? details.date : "";
  const date = parseLetterDate(rawDate) ?? "";
  if (!rawDate) reasons.push("No date was read");
  else if (!date) reasons.push(`Could not read the date "${rawDate}"`);
  const type = ProposalSchema.shape.documentType.safeParse(
    details.documentType,
  );
  if (!type.success) reasons.push("No document type was read");
  return {
    proposal: {
      sender: folder ?? sender,
      date,
      documentType: type.success ? type.data : "other",
      title: "",
    },
    reasons,
  };
}

/** The scanner's details and header record for each letter, by hash. */
async function scans(
  context: Context,
  scanner: string,
  pdfs: Pdf[],
): Promise<Map<string, { details?: DataRecord; header?: DataRecord }>> {
  const names = pdfs.flatMap((p) => [
    `details-${shortHash(p.hash)}`,
    `header-${shortHash(p.hash)}`,
  ]);
  const records = names.length === 0 ? new Map() : latestByName(
    await context.queryData(
      `modelName == ${JSON.stringify(scanner)} && name in ${
        JSON.stringify(names)
      }`,
    ) as DataRecord[],
  );
  return new Map(pdfs.map((p) => [p.hash, {
    details: records.get(`details-${shortHash(p.hash)}`),
    header: records.get(`header-${shortHash(p.hash)}`),
  }]));
}

/** The letter as it is now, held with the error when the work threw. */
async function settle(
  letter: Letter,
  work: () => Promise<Letter>,
): Promise<Letter> {
  try {
    return await work();
  } catch (error) {
    return { ...letter, state: "held", reasons: [(error as Error).message] };
  }
}

/** Why fields a person gave cannot be filed with; empty when they can. */
function fieldProblems(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const sender = typeof fields.sender === "string" ? fields.sender : "";
  if (!cleanSegment(sender)) problems.push("A sender is needed");
  const date = typeof fields.date === "string" ? fields.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseLetterDate(date) !== date) {
    problems.push("The date must be a real date, YYYY-MM-DD");
  }
  if (
    !ProposalSchema.shape.documentType.safeParse(fields.documentType).success
  ) {
    problems.push(`Unknown document type "${fields.documentType}"`);
  }
  if (typeof fields.filename === "string" && fields.filename !== "") {
    const problem = filenameProblem(fields.filename);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** Every letter this filer holds. */
async function letters(context: Context): Promise<Letter[]> {
  const all = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  const result: Letter[] = [];
  for (const { name } of all) {
    if (!name.startsWith("letter-")) continue;
    const stored = await context.readResource(name);
    if (stored) result.push(LetterSchema.parse(stored));
  }
  return result;
}

/**
 * Save a letter's record, and its header: the image given, or the one this
 * filer holds once the letter is done. A filed or skipped letter's record
 * and header are written to expire after the retention. Each is written
 * once, as swamp allows only one write of a name per method run.
 */
async function save(
  context: Context,
  g: Globals,
  letter: Letter,
  header?: Uint8Array | null,
): Promise<DataHandle[]> {
  const done = letter.state === "filed" || letter.state === "skipped";
  const overrides = done ? { lifetime: g.retention } : undefined;
  const handles = [
    await context.writeResource(
      "letter",
      letterId(letter.contentHash),
      { ...letter, updatedAt: new Date().toISOString() },
      overrides,
    ),
  ];
  const name = headerName(letter.contentHash);
  const png = header ?? (done
    ? await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      name,
    )
    : null);
  if (png) {
    handles.push(
      await context.createFileWriter("header", name, overrides).writeAll(png),
    );
  }
  return handles;
}

/**
 * File a letter: copy it into the cabinet, never over another file unless
 * told to overwrite, then move its original into Archived.
 */
async function fileLetter(
  inbound: string,
  letter: Letter,
  fields: Proposal,
  overwrite: boolean,
): Promise<Letter> {
  const archiveDir = folder(inbound, "archived");
  // An interrupted filing may have archived the original already.
  let source: string | null = letter.pdfPath;
  const hash = await fileHash(source);
  if (hash === null) {
    source = await movedTo(archiveDir, letter.pdfPath, letter.contentHash);
  } else if (hash !== letter.contentHash) {
    throw new Error(
      `${letter.pdfPath} has changed since it was scanned; put it back in Incoming to scan it again`,
    );
  }
  if (source === null) {
    throw new Error(`The letter is no longer at ${letter.pdfPath}`);
  }

  const dest = destinationPath(letter.cabinetDir, fields as FilingFields);
  const there = await fileHash(dest);
  if (there !== letter.contentHash) {
    if (there !== null && !overwrite) {
      return {
        ...letter,
        state: "conflict",
        proposal: fields,
        reasons: [`Another file is already at ${dest}`],
        destination: dest,
      };
    }
    const bytes = await Deno.readFile(source);
    await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    if (there === null) {
      await Deno.writeFile(dest, bytes, { createNew: true });
    } else {
      const temp = `${dest}.${shortHash(letter.contentHash)}.tmp`;
      await Deno.writeFile(temp, bytes);
      await Deno.rename(temp, dest);
    }
    if (await fileHash(dest) !== letter.contentHash) {
      await Deno.remove(dest);
      throw new Error(`The copy at ${dest} did not match; nothing was filed`);
    }
  }
  const archivedPath = source === letter.pdfPath
    ? await moveInto(archiveDir, letter.pdfPath, letter.contentHash)
    : source;
  return {
    ...letter,
    state: "filed",
    pdfPath: archivedPath,
    proposal: fields,
    reasons: [],
    destination: dest,
    archivedPath,
  };
}

/** The @zts/home-mail-room/filer behavior. */
export const behavior = {
  type: "@zts/home-mail-room/filer",
  version: "2026.11.07.1",
  globalArguments: GlobalArgsSchema,
  // Instances made before the first release, at 2026.11.06.1.
  upgrades: [
    {
      toVersion: "2026.11.07.1",
      description: "First published release; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  // After every run, including each decide the review page makes.
  reports: ["@zts/home-mail-room/letters"],
  resources: {
    "letter": {
      description:
        "One scanned letter: what was read off it, how to file it, and where it is",
      schema: LetterSchema,
      // Filed and skipped letters are written with the retention lifetime.
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "run": {
      description:
        "What one fileReady (file-ready) or decide (decisions) run did to each letter",
      schema: RunSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  files: {
    "header": {
      description: "The rendered top of the letter, copied from the scanner",
      contentType: "image/png",
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    fileReady: {
      description:
        "Review every letter in ReadyToFile, filing those it can on its own and holding the rest for a person",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const inbound = resolve(context.repoDir, g.inboundDir);
        const cabinetDir = resolve(context.repoDir, g.cabinetDir);
        const folders = await cabinetFolders(cabinetDir);
        const renames = await readSenderNames(cabinetDir);
        const ready = await pdfsIn(
          folder(inbound, "readyToFile"),
          (m, p) => context.logger.warning(m, p),
        );
        const scanned = await scans(context, g.scanner, ready);
        const handles: DataHandle[] = [];
        const outcomes: Outcome[] = [];
        const seen = new Set<string>();

        for (const pdf of ready) {
          const id = letterId(pdf.hash);
          seen.add(id);
          const stored = await context.readResource(id);
          const existing = stored ? LetterSchema.parse(stored) : null;
          // A person's decision that could not be applied waits for them.
          if (existing && OPEN.has(existing.state) && existing.decision) {
            outcomes.push({
              ...outcomeOf(existing, "person"),
              outcome: "waiting",
            });
            continue;
          }
          // A copy of a letter already in the cabinet: only the original
          // is needed, and the cabinet has it.
          if (
            existing?.state === "filed" && existing.destination &&
            await fileHash(existing.destination) === pdf.hash
          ) {
            await moveInto(folder(inbound, "archived"), pdf.path, pdf.hash);
            outcomes.push({
              ...outcomeOf(existing, "filer"),
              originalName: pdf.path.slice(pdf.path.lastIndexOf("/") + 1),
              outcome: "duplicate",
            });
            continue;
          }

          const scan = scanned.get(pdf.hash)!;
          const details = scan.details?.attributes ?? existing?.extracted;
          const { proposal, reasons } = details
            ? review(details, folders, renames)
            : {
              proposal: {
                sender: "",
                date: "",
                documentType: "other" as const,
                title: "",
              },
              reasons: [
                "Nothing was read off this letter; put it back in Incoming to read it",
              ],
            };
          const header = scan.header?.modelId && scan.header.modelType
            ? await context.dataRepository.getContent(
              scan.header.modelType,
              scan.header.modelId,
              scan.header.name,
            )
            : null;
          let letter: Letter = {
            state: "held",
            pdfPath: pdf.path,
            originalName: pdf.path.slice(pdf.path.lastIndexOf("/") + 1),
            contentHash: pdf.hash,
            cabinetDir,
            extracted: details ?? {},
            proposal,
            reasons,
            updatedAt: new Date().toISOString(),
          };
          if (reasons.length === 0) {
            letter = await settle(
              letter,
              () => fileLetter(inbound, letter, proposal, false),
            );
          }
          handles.push(...await save(context, g, letter, header));
          outcomes.push(outcomeOf(letter, "filer"));
        }

        // A letter waiting for a person whose file has left ReadyToFile is
        // no longer waiting: someone moved it. Put back, it comes back.
        for (const letter of await letters(context)) {
          const id = letterId(letter.contentHash);
          if (!OPEN.has(letter.state) || seen.has(id)) continue;
          await context.deleteResource(id);
          await context.deleteResource(headerName(letter.contentHash));
          context.logger.warning(
            "{letter} left ReadyToFile without a decision; dropped its record",
            { letter: id },
          );
          outcomes.push({
            ...outcomeOf(letter, "filer"),
            outcome: "dropped",
            reasons: ["Its file left ReadyToFile without a decision"],
          });
        }

        const counts: Record<string, number> = {};
        for (const o of outcomes) {
          counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
        }
        context.logger.info("Letters in ReadyToFile: {counts}", {
          counts: JSON.stringify(counts),
        });
        handles.push(
          await context.writeResource("run", "file-ready", {
            method: "fileReady",
            letters: outcomes,
            finishedAt: new Date().toISOString(),
          }),
        );
        return { dataHandles: handles };
      },
    },
    decide: {
      description:
        "Apply a person's decisions: file letters, with any fields they changed, or skip them",
      arguments: DecideArgsSchema,
      execute: async (
        args: z.input<typeof DecideArgsSchema>,
        context: Context,
      ) => {
        const { decisions } = DecideArgsSchema.parse(args);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const inbound = resolve(context.repoDir, g.inboundDir);
        const handles: DataHandle[] = [];
        const outcomes: Outcome[] = [];
        const refuse = (letter: string, originalName: string, reason: string) =>
          outcomes.push({
            letter,
            originalName,
            outcome: "refused",
            by: "person",
            destination: null,
            reasons: [reason],
          });
        for (const d of decisions) {
          const stored = await context.readResource(d.letter);
          if (!stored) {
            context.logger.warning("No letter {letter}", { letter: d.letter });
            refuse(d.letter, "", "No such letter");
            continue;
          }
          const letter = LetterSchema.parse(stored);
          if (!OPEN.has(letter.state)) {
            context.logger.warning("{letter} is already {state}", {
              letter: d.letter,
              state: letter.state,
            });
            refuse(d.letter, letter.originalName, `Already ${letter.state}`);
            continue;
          }
          const { letter: _id, action, overwrite, ...overrides } = d;
          const decided: Letter = {
            ...letter,
            decision: {
              action,
              overwrite,
              ...overrides,
              decidedAt: new Date().toISOString(),
            },
          };
          const after = await settle(decided, async () => {
            if (action === "skip") {
              const skippedTo = await moveInto(
                folder(inbound, "skipped"),
                letter.pdfPath,
                letter.contentHash,
              );
              return {
                ...decided,
                state: "skipped" as const,
                pdfPath: skippedTo,
                reasons: [],
                archivedPath: skippedTo,
              };
            }
            const fields = { ...letter.proposal, ...overrides };
            const problems = fieldProblems(fields);
            if (problems.length) {
              return { ...decided, state: "held" as const, reasons: problems };
            }
            return fileLetter(inbound, decided, fields as Proposal, overwrite);
          });
          handles.push(...await save(context, g, after));
          outcomes.push(outcomeOf(after, "person"));
        }
        handles.push(
          await context.writeResource("run", "decisions", {
            method: "decide",
            letters: outcomes,
            finishedAt: new Date().toISOString(),
          }),
        );
        return { dataHandles: handles };
      },
    },
    renameSender: {
      description:
        "Rename the sender of letters, remember it in the cabinet's senders.yaml, and re-review every open letter from that sender",
      arguments: RenameArgsSchema,
      execute: async (
        args: z.input<typeof RenameArgsSchema>,
        context: Context,
      ) => {
        const a = RenameArgsSchema.parse(args);
        const sender = cleanSegment(a.sender);
        if (!sender) throw new Error("The sender's name cannot be empty");
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const cabinetDir = resolve(context.repoDir, g.cabinetDir);
        const open = (await letters(context)).filter((l) =>
          OPEN.has(l.state) && !l.decision
        );
        const given = open.filter((l) =>
          a.letters.includes(letterId(l.contentHash))
        );
        // Each way the sender was read is renamed; a letter with none read
        // only takes the name.
        const read = [...new Set(given.map((l) => readSender(l.extracted)))]
          .filter(Boolean);
        if (read.length > 0) {
          await addSenderNames(
            cabinetDir,
            Object.fromEntries(read.map((r) => [r, sender])),
          );
        }
        const keys = new Set(read.map(senderKey));
        const renames = await readSenderNames(cabinetDir);
        const folders = await cabinetFolders(cabinetDir);
        const handles: DataHandle[] = [];
        const outcomes: Outcome[] = [];
        for (const letter of open) {
          const raw = readSender(letter.extracted);
          const isGiven = given.includes(letter);
          if (!(raw ? keys.has(senderKey(raw)) : isGiven)) continue;
          const details = raw
            ? letter.extracted
            : { ...letter.extracted, sender };
          const after: Letter = {
            ...letter,
            state: "held",
            ...review(details, folders, renames),
          };
          handles.push(...await save(context, g, after));
          outcomes.push(outcomeOf(after, "person"));
        }
        context.logger.info(
          "Renamed the sender of {count} letters to {sender}",
          {
            count: outcomes.length,
            sender,
          },
        );
        handles.push(
          await context.writeResource("run", "renames", {
            method: "renameSender",
            letters: outcomes,
            finishedAt: new Date().toISOString(),
          }),
        );
        return { dataHandles: handles };
      },
    },
  },
};
