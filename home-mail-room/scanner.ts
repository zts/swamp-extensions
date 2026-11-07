/**
 * Reads scanned letters in Inbound/Incoming with an installed
 * @zts/qianfan-ocr behavior, a batch at a time, and moves each one on: to
 * ReadyToFile once it has been read, or to Failed when it cannot be.
 *
 * listIncoming splits Incoming into batches; scanBatch reads one batch with
 * one load of the model. It reads the top of each first page, then the whole
 * page of any letter whose sender or date the top did not show, while the
 * model is still loaded. A letter's details are written before it is moved,
 * so a run that stops between the two reads it again at worst.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { DOCUMENT_TYPES } from "./filing.ts";
import {
  fileHash,
  folder,
  moveInto,
  pdfsIn,
  resolve,
  shortHash,
} from "./inbound.ts";
import { MAX_DPI, MIN_DPI, renderTop } from "./render.ts";

type DocumentType = typeof DOCUMENT_TYPES[number];

/** Answers that mean the model saw no document type. */
const NO_TYPE = new Set(["", "unknown", "none", "null", "n/a"]);

/** The letter prompt; the model returns these keys as JSON. */
export const DEFAULT_PROMPT =
  "This image is the top of the first page of a letter received in the post. " +
  "Extract the following fields and output them as standard JSON with exactly these keys: " +
  '"sender" (the organisation or person who sent the letter), ' +
  '"date" (the date of the letter, as written), ' +
  '"recipient" (name of the addressee), ' +
  '"recipient_address", ' +
  `"document_type" (exactly one of: ${DOCUMENT_TYPES.join(", ")}), ` +
  '"reference_numbers" (an object mapping each label, such as account number or ' +
  "bill reference, to its value), " +
  '"other_details" (an object of any other key facts, such as amounts due or periods covered). ' +
  "Use null for any field that is not visible.";

const NAME = /^[A-Za-z0-9_-]+$/;

/** Prefix of the temp dir a batch renders its images into. */
const SCRATCH = "home-mail-room-scan-";

/**
 * A first page at least this many times taller than it is wide is a till or
 * card receipt: A4 is 1.41, US legal 1.65, an 80mm receipt usually over 1.8.
 */
const RECEIPT_RATIO = 1.8;

/** Older than this, a batch's temp dir was left by a batch that was killed. */
const STALE_MS = 24 * 60 * 60 * 1000;

const GlobalArgsSchema = z.object({
  inboundDir: z.string().min(1).default("Inbound").describe(
    "Folder holding Incoming, ReadyToFile and Failed; absolute, or relative to the repository",
  ),
  ocrBehavior: z.string().regex(NAME).default("qianfan-ocr").describe(
    "Name of the @zts/qianfan-ocr behavior that reads the image; create and install it first",
  ),
});

const ListArgsSchema = z.object({
  run: z.string().regex(NAME).describe(
    "Name the list incoming-<run>, so concurrent workflow runs keep their own",
  ),
  batchSize: z.number().int().min(1).default(20).describe(
    "Letters read with each load of the model",
  ),
  maxBatches: z.number().int().min(0).default(0).describe(
    "Most batches to list, 0 for all; the rest of Incoming waits for the next run",
  ),
});

const ScanBatchArgsSchema = z.object({
  list: z.string().regex(NAME).describe("The run listIncoming was given"),
  batch: z.number().int().min(0).describe("Which of the list's batches"),
  page: z.number().int().min(1).default(1).describe("1-based page to read"),
  fraction: z.number().gt(0).max(1).default(0.25).describe(
    "Share of the page, from the top, to read first",
  ),
  retryFullPage: z.boolean().default(true).describe(
    "Read the whole page of a letter whose sender or date the top did not show",
  ),
  dpi: z.number().int().min(MIN_DPI).max(MAX_DPI).default(200).describe(
    "Render resolution",
  ),
  prompt: z.string().min(1).optional().describe("Replace the letter prompt"),
  maxNewTokens: z.number().int().min(1).default(1024).describe(
    "Most tokens the model may generate",
  ),
});

type ScanBatchArgs = z.infer<typeof ScanBatchArgsSchema>;

const DetailsSchema = z.object({
  originalName: z.string().describe("The file's name when it was read"),
  pdfPath: z.string().describe("Where the file was when it was read"),
  contentHash: z.string().describe("SHA-256 of the PDF file, in hex"),
  page: z.number(),
  fraction: z.number().describe("Share of the page the answer came from"),
  dpi: z.number(),
  sender: z.string().nullable(),
  date: z.string().nullable(),
  recipient: z.string().nullable(),
  recipientAddress: z.string().nullable(),
  documentType: z.enum(DOCUMENT_TYPES).nullable(),
  documentTypeRaw: z.string().nullable().describe(
    "The model's own words for the document type",
  ),
  referenceNumbers: z.record(z.string(), z.string()),
  otherDetails: z.record(z.string(), z.unknown()),
  parsedOk: z.boolean().describe("Whether the model's answer held JSON"),
  rawOutput: z.string(),
  prompt: z.string(),
  ocr: z.object({
    behavior: z.string(),
    name: z.string(),
    version: z.number(),
  }).describe("The qianfan-ocr record this was read from"),
  model: z.string(),
  revision: z.string(),
  device: z.string(),
  scannedAt: z.string(),
});

type Details = z.infer<typeof DetailsSchema>;

const ListSchema = z.object({
  directory: z.string(),
  total: z.number(),
  batches: z.array(z.object({
    index: z.number(),
    files: z.array(z.object({ path: z.string(), hash: z.string() })),
  })),
  waiting: z.number().describe("Letters left for a later run by maxBatches"),
  listedAt: z.string(),
});

const STATUSES = [
  "read",
  "known",
  "unreadable",
  "gone",
  "notRun",
  "error",
] as const;

type Status = typeof STATUSES[number];

const ScanBatchSchema = z.object({
  letters: z.array(z.object({
    path: z.string(),
    hash: z.string(),
    status: z.enum(STATUSES).describe(
      "read or known: moved to ReadyToFile; unreadable: moved to Failed; " +
        "gone: no longer in Incoming; notRun or error: left in Incoming",
    ),
    fullPage: z.boolean().describe("Whether the whole page was read too"),
    details: z.string().nullable(),
    readBefore: z.string().nullable().describe(
      "When a known letter was read, by an earlier batch",
    ),
    movedTo: z.string().nullable(),
    error: z.string().nullable(),
  })),
  batches: z.array(z.object({ name: z.string(), version: z.number() }))
    .describe("The qianfan-ocr batch records the letters were read from"),
  loadMs: z.number().nullable(),
  error: z.string().nullable().describe(
    "Why the model could not read the batch, if it could not",
  ),
  scannedAt: z.string(),
});

type Outcome = z.infer<typeof ScanBatchSchema>["letters"][number];

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface Context {
  globalArgs: z.input<typeof GlobalArgsSchema>;
  repoDir: string;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
  createFileWriter(specName: string, name: string): {
    writeAll(content: Uint8Array): Promise<DataHandle>;
  };
  runModel(options: {
    definition: string;
    method: string;
    arguments: Record<string, unknown>;
  }): Promise<
    | { ok: true; resources: DataHandle[] }
    | { ok: false; error: { message: string } }
  >;
  queryData(predicate: string): Promise<unknown[]>;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The model's document type, matched to the set; null when it saw none. */
export function normaliseDocumentType(raw: unknown): {
  documentType: DocumentType | null;
  documentTypeRaw: string | null;
} {
  const documentTypeRaw = str(raw);
  const key = (documentTypeRaw ?? "").trim().toLowerCase();
  if (NO_TYPE.has(key)) return { documentType: null, documentTypeRaw };
  const documentType = (DOCUMENT_TYPES as readonly string[]).includes(key)
    ? key as DocumentType
    : "other";
  return { documentType, documentTypeRaw };
}

/** The letter fields of a parsed answer, coerced to the details schema. */
export function toDetails(parsed: Record<string, unknown> | null) {
  const p = parsed ?? {};
  const refs = isObject(p.reference_numbers) ? p.reference_numbers : {};
  return {
    sender: str(p.sender),
    date: str(p.date),
    recipient: str(p.recipient),
    recipientAddress: str(p.recipient_address),
    ...normaliseDocumentType(p.document_type),
    referenceNumbers: Object.fromEntries(
      Object.entries(refs).flatMap(([k, v]) => {
        const s = str(v);
        return s === null ? [] : [[k, s]];
      }),
    ) as Record<string, string>,
    otherDetails: isObject(p.other_details) ? p.other_details : {},
  };
}

/** Whether an answer gave what filing needs most: a sender and a date. */
function complete(ocr: Record<string, unknown>): boolean {
  const fields = toDetails(isObject(ocr.parsed) ? ocr.parsed : null);
  return fields.sender !== null && fields.date !== null;
}

/** Why a call to qianfan-ocr failed, and how to set it up. */
function ocrFailure(ocrBehavior: string, error: { message: string }): string {
  const message = error.message.replace(/\.$/, "");
  // swamp's runModel and workflow wordings for a method the type lacks.
  if (
    /unknown method 'extractBatch'|method 'extractBatch' not found/i.test(
      message,
    )
  ) {
    return `qianfan-ocr behavior '${ocrBehavior}' failed: ${message}. ` +
      `The scanner needs @zts/qianfan-ocr 2026.11.03.1 or later: run ` +
      `swamp extension pull @zts/qianfan-ocr, then ` +
      `swamp behavior run ${ocrBehavior} install`;
  }
  return `qianfan-ocr behavior '${ocrBehavior}' failed: ${message}. ` +
    `If it does not exist yet, create and install it: ` +
    `swamp behavior create @zts/qianfan-ocr ${ocrBehavior}, then ` +
    `swamp behavior run ${ocrBehavior} install`;
}

/** One image for the model: the record name it takes, and where it is. */
interface Image {
  name: string;
  path: string;
}

/** What the model made of one image. */
type Read =
  | {
    status: "ok";
    ocr: Record<string, unknown>;
    record: { name: string; version: number };
  }
  | { status: "error"; error: string };

/** One extractBatch: each image's read, by name; absent ones did not run. */
interface Extracted {
  reads: Map<string, Read>;
  batch: { name: string; version: number } | null;
  loadMs: number | null;
  failure: string | null;
}

/** The newest version of a record, or undefined. */
function latest<T extends { version?: number }>(records: T[]): T | undefined {
  return records.reduce<T | undefined>(
    (best, r) => (best && (best.version ?? 0) >= (r.version ?? 0) ? best : r),
    undefined,
  );
}

/** Read images with one extractBatch call: one load of the model. */
async function extract(
  context: Context,
  ocrBehavior: string,
  images: Image[],
  prompt: string,
  maxNewTokens: number,
  base: string,
): Promise<Extracted> {
  const out: Extracted = {
    reads: new Map(),
    batch: null,
    loadMs: null,
    failure: null,
  };
  const result = await context.runModel({
    definition: ocrBehavior,
    method: "extractBatch",
    arguments: {
      items: images.map((i) => ({ imagePath: i.path, prompt, name: i.name })),
      maxNewTokens,
      // qianfan-ocr adds the batch- prefix.
      name: base,
    },
  });
  // extractBatch fails part way after writing its batch record, and
  // runModel then returns no handles, so look it up by name.
  const handle = result.ok
    ? result.resources.find((r) => r.specName === "batch")
    : undefined;
  const records = !result.ok || handle
    ? await context.queryData(
      `modelName == "${ocrBehavior}" && name == "${
        handle?.name ?? `batch-${base}`
      }"` +
        (handle?.version !== undefined
          ? ` && version == ${handle.version}`
          : ""),
    ) as { name: string; version: number; attributes?: unknown }[]
    : [];
  const record = latest(records);
  if (!record?.attributes) {
    out.failure = result.ok
      ? `qianfan-ocr behavior '${ocrBehavior}' wrote no batch record`
      : ocrFailure(ocrBehavior, result.error);
    return out;
  }
  const read = record.attributes as {
    items: {
      status: "ok" | "error" | "notRun";
      record: string | null;
      recordVersion: number | null;
      error: string | null;
    }[];
    loadMs: number | null;
    error: string | null;
  };
  out.batch = { name: record.name, version: record.version };
  out.loadMs = read.loadMs ?? null;
  if (read.error) {
    out.failure =
      `qianfan-ocr's batch ${record.name} failed part way: ${read.error}`;
  } else if (!result.ok) {
    out.failure = ocrFailure(ocrBehavior, result.error);
  }
  // Items are in the order sent; anything else is a qianfan bug, and
  // guessing which letter an item belongs to would misfile it.
  const mismatch =
    `qianfan-ocr's batch ${record.name} does not match what was sent`;
  if (read.items.length !== images.length) {
    out.failure ??=
      `${mismatch}: ${read.items.length} items for ${images.length} images`;
  }
  for (const [i, image] of images.entries()) {
    const item = read.items[i];
    if (!item || item.status === "notRun") continue;
    if (item.status === "error") {
      out.reads.set(image.name, {
        status: "error",
        error: item.error ?? "the model failed",
      });
      continue;
    }
    if (item.record !== `ocr-${image.name}`) {
      out.failure ??= `${mismatch}: ${image.name} got ${item.record}`;
      continue;
    }
    // The version this batch wrote, never the latest.
    const ocr = await context.queryData(
      `modelName == "${ocrBehavior}" && name == "${item.record}" && version == ${item.recordVersion}`,
    ) as { attributes?: Record<string, unknown> }[];
    if (!ocr[0]?.attributes) {
      out.failure ??=
        `qianfan-ocr wrote ${item.record} version ${item.recordVersion}, but it is no longer there to read`;
      continue;
    }
    out.reads.set(image.name, {
      status: "ok",
      ocr: ocr[0].attributes,
      record: { name: item.record, version: item.recordVersion! },
    });
  }
  return out;
}

/**
 * A new temp dir for a batch's images. A batch removes its own when it ends,
 * but not when its process is killed, so any left over a day ago go first.
 */
async function scratchDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: SCRATCH });
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  try {
    for await (const entry of Deno.readDir(parent)) {
      if (!entry.isDirectory || !entry.name.startsWith(SCRATCH)) continue;
      const path = `${parent}/${entry.name}`;
      const mtime = path === dir ? null : (await Deno.stat(path)).mtime;
      if (mtime && Date.now() - mtime.getTime() > STALE_MS) {
        await Deno.remove(path, { recursive: true });
      }
    }
  } catch {
    // Clearing up after another batch must not stop this one.
  }
  return dir;
}

/** The details record of a letter the model read. */
function detailsFrom(
  pdf: { path: string; hash: string },
  a: ScanBatchArgs,
  fraction: number,
  prompt: string,
  ocrBehavior: string,
  read: Extract<Read, { status: "ok" }>,
  receipt: boolean,
): Details {
  const parsed = isObject(read.ocr.parsed) ? read.ocr.parsed : null;
  const fields = toDetails(parsed);
  // The page's shape tells a receipt better than the model's words do.
  if (receipt) fields.documentType = "receipt";
  return DetailsSchema.parse({
    originalName: pdf.path.slice(pdf.path.lastIndexOf("/") + 1),
    pdfPath: pdf.path,
    contentHash: pdf.hash,
    page: a.page,
    fraction,
    dpi: a.dpi,
    ...fields,
    parsedOk: parsed !== null,
    rawOutput: String(read.ocr.rawOutput ?? ""),
    prompt,
    ocr: { behavior: ocrBehavior, ...read.record },
    model: String(read.ocr.model ?? ""),
    revision: String(read.ocr.revision ?? ""),
    device: String(read.ocr.device ?? ""),
    scannedAt: new Date().toISOString(),
  });
}

/** The @zts/home-mail-room/scanner behavior. */
export const behavior = {
  type: "@zts/home-mail-room/scanner",
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
  resources: {
    "details": {
      description:
        "What was read off a letter, named by its content: details-<short hash>",
      schema: DetailsSchema,
      // Kept while a letter may wait in ReadyToFile; the filer keeps a copy.
      lifetime: "90d",
      garbageCollection: 5,
    },
    "incomingList": {
      description: "The letters in Incoming, split into batches for a run",
      schema: ListSchema,
      // Each workflow run writes its own list and reads it minutes later.
      lifetime: "7d",
      garbageCollection: 10,
    },
    "scanBatch": {
      description: "One batch: what became of each letter in it",
      schema: ScanBatchSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  files: {
    "header": {
      description: "The rendered part of the letter the details were read from",
      contentType: "image/png",
      lifetime: "90d",
      garbageCollection: 5,
    },
  },
  methods: {
    listIncoming: {
      description:
        "Split the letters in Incoming into batches, for scanBatch to read one at a time",
      arguments: ListArgsSchema,
      execute: async (
        args: z.input<typeof ListArgsSchema>,
        context: Context,
      ) => {
        const a = ListArgsSchema.parse(args);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const directory = folder(
          resolve(context.repoDir, g.inboundDir),
          "incoming",
        );
        const pdfs = await pdfsIn(
          directory,
          (m, p) => context.logger.warning(m, p),
        );
        const batches = [];
        for (let i = 0; i < pdfs.length; i += a.batchSize) {
          if (a.maxBatches > 0 && batches.length >= a.maxBatches) {
            break;
          }
          batches.push({
            index: batches.length,
            files: pdfs.slice(i, i + a.batchSize),
          });
        }
        const listed = batches.reduce((n, b) => n + b.files.length, 0);
        const handle = await context.writeResource(
          "incomingList",
          `incoming-${a.run}`,
          {
            directory,
            total: pdfs.length,
            batches,
            waiting: pdfs.length - listed,
            listedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Found {total} letters in {directory}: {batches} batches, {waiting} left for a later run",
          {
            total: pdfs.length,
            directory,
            batches: batches.length,
            waiting: pdfs.length - listed,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    scanBatch: {
      description:
        "Read one batch of listed letters with one load of the OCR model, then move each to ReadyToFile or Failed",
      arguments: ScanBatchArgsSchema,
      execute: async (
        args: z.input<typeof ScanBatchArgsSchema>,
        context: Context,
      ) => {
        const a = ScanBatchArgsSchema.parse(args);
        const g = GlobalArgsSchema.parse(context.globalArgs);
        const inbound = resolve(context.repoDir, g.inboundDir);
        const prompt = a.prompt ?? DEFAULT_PROMPT;
        const listName = `incoming-${a.list}`;
        const list = await context.readResource(listName);
        if (!list) {
          throw new Error(`No list ${listName}: run listIncoming first`);
        }
        const files = ListSchema.parse(list).batches[a.batch]?.files;
        if (!files) throw new Error(`${listName} has no batch ${a.batch}`);

        const handles: DataHandle[] = [];
        const outcomes: Outcome[] = [];
        const outcome = (
          pdf: { path: string; hash: string },
          status: Status,
          error: string | null = null,
        ): Outcome => {
          const o: Outcome = {
            path: pdf.path,
            hash: pdf.hash,
            status,
            fullPage: false,
            details: null,
            readBefore: null,
            movedTo: null,
            error,
          };
          outcomes.push(o);
          return o;
        };

        // Each letter is read once, however many copies of it there are.
        const byHash = new Map<string, Outcome[]>();
        for (const f of files) {
          const hash = await fileHash(f.path);
          if (hash === null) {
            outcome(f, "gone", "No longer in Incoming");
            continue;
          }
          if (hash !== f.hash) {
            outcome(
              f,
              "gone",
              "Changed since it was listed; the next run reads it",
            );
            continue;
          }
          const o = outcome(f, "notRun");
          const known = await context.readResource(
            `details-${shortHash(hash)}`,
          );
          if (known) {
            o.status = "known";
            o.details = `details-${shortHash(hash)}`;
            o.readBefore = str(known.scannedAt);
            continue;
          }
          byHash.set(hash, [...(byHash.get(hash) ?? []), o]);
        }

        const tmpDir = await scratchDir();
        const extracted: Extracted[] = [];
        /** Why a letter could not be rendered: it is no readable PDF. */
        const unrenderable = new Map<string, string>();
        /** Letters whose first page is shaped like a receipt. */
        const receipts = new Set<string>();
        try {
          /** Render the top of each letter to <name>.png in tmpDir. */
          const render = async (hashes: string[], fraction: number) => {
            const images = new Map<string, Image>();
            for (const hash of hashes) {
              const first = byHash.get(hash)![0];
              const name = fraction === 1
                ? `${shortHash(hash)}-page`
                : shortHash(hash);
              try {
                const top = await renderTop(await Deno.readFile(first.path), {
                  page: a.page,
                  fraction,
                  dpi: a.dpi,
                });
                if (top.pageHeight >= top.width * RECEIPT_RATIO) {
                  receipts.add(hash);
                }
                const path = `${tmpDir}/${name}.png`;
                await Deno.writeFile(path, top.png);
                images.set(hash, { name, path });
              } catch (error) {
                unrenderable.set(hash, errorMessage(error));
              }
            }
            return images;
          };
          const read = async (images: Map<string, Image>, suffix: string) => {
            if (images.size === 0) return new Map<string, Read>();
            const result = await extract(
              context,
              g.ocrBehavior,
              [...images.values()],
              prompt,
              a.maxNewTokens,
              `${a.list}-${a.batch}${suffix}`,
            );
            extracted.push(result);
            return new Map(
              [...images].flatMap(([hash, image]) => {
                const r = result.reads.get(image.name);
                return r ? [[hash, r] as const] : [];
              }),
            );
          };

          const tops = await render([...byHash.keys()], a.fraction);
          const first = await read(tops, "");
          const again = a.retryFullPage && a.fraction < 1
            ? [...tops.keys()].filter((h) => {
              const r = first.get(h);
              return r?.status === "error" ||
                (r?.status === "ok" && !complete(r.ocr));
            })
            : [];
          const pages = await render(again, 1);
          const second = await read(pages, "-page");

          for (const [hash, copies] of byHash) {
            const fail = (error: string) => {
              for (const o of copies) {
                o.status = "unreadable";
                o.error = error;
              }
            };
            if (!tops.has(hash)) {
              fail(unrenderable.get(hash)!);
              continue;
            }
            for (const o of copies) o.fullPage = pages.has(hash);
            const top = first.get(hash);
            const page = second.get(hash);
            // Either read the model did not get to: left in Incoming.
            if (!top || (again.includes(hash) && pages.has(hash) && !page)) {
              continue;
            }
            // The whole page's answer when it parsed, else the top's; an
            // answer with no JSON is kept as what was read, then Failed.
            const reads = [
              { r: page, fraction: 1, image: pages.get(hash) },
              { r: top, fraction: a.fraction, image: tops.get(hash) },
            ].flatMap(({ r, fraction, image }) =>
              r?.status === "ok" ? [{ r, fraction, image: image! }] : []
            );
            const use = reads.find((u) => isObject(u.r.ocr.parsed)) ??
              reads[0];
            if (!use) {
              const error = page ?? top;
              fail(error.status === "error" ? error.error : "Not read");
              continue;
            }
            const ok = use.r;
            try {
              const details = detailsFrom(
                { path: copies[0].path, hash },
                a,
                use.fraction,
                prompt,
                g.ocrBehavior,
                ok,
                receipts.has(hash),
              );
              // details first: if its write fails, no header is left without it.
              const name = shortHash(hash);
              const d = await context.writeResource(
                "details",
                `details-${name}`,
                details,
              );
              handles.push(d);
              handles.push(
                await context.createFileWriter("header", `header-${name}`)
                  .writeAll(await Deno.readFile(use.image.path)),
              );
              for (const o of copies) {
                o.details = d.name;
                o.status = details.parsedOk ? "read" : "unreadable";
                if (!details.parsedOk) {
                  o.error = "The model's answer held no JSON";
                }
              }
            } catch (error) {
              for (const o of copies) {
                o.status = "error";
                o.error = errorMessage(error);
              }
            }
          }
        } finally {
          await Deno.remove(tmpDir, { recursive: true });
        }

        for (const o of outcomes) {
          const to = o.status === "read" || o.status === "known"
            ? "readyToFile"
            : o.status === "unreadable"
            ? "failed"
            : null;
          if (!to) continue;
          try {
            o.movedTo = await moveInto(folder(inbound, to), o.path, o.hash);
          } catch (error) {
            o.status = "error";
            o.error = `Not moved: ${errorMessage(error)}`;
          }
        }

        const failure = extracted.map((e) => e.failure).find((f) => f) ?? null;
        const summary = ScanBatchSchema.parse({
          letters: outcomes,
          batches: extracted.flatMap((e) => e.batch ? [e.batch] : []),
          loadMs: extracted[0]?.loadMs ?? null,
          error: failure,
          scannedAt: new Date().toISOString(),
        });
        const summaryHandle = await context.writeResource(
          "scanBatch",
          `scan-batch-${a.list}-${a.batch}`,
          summary,
        );
        handles.push(summaryHandle);
        const count = (s: Status) =>
          outcomes.filter((o) => o.status === s).length;
        // The letters' contents stay out of the logs.
        context.logger.info(
          "Batch {batch}: {read} read, {known} already read, {unreadable} to Failed, {left} left in Incoming",
          {
            batch: a.batch,
            read: count("read"),
            known: count("known"),
            unreadable: count("unreadable"),
            left: count("notRun") + count("error"),
          },
        );
        for (const o of outcomes.filter((o) => o.status === "known")) {
          context.logger.info(
            "Batch {batch}: not reading {letter} again; it was read at {readBefore} ({details})",
            {
              batch: a.batch,
              letter: o.path.slice(o.path.lastIndexOf("/") + 1),
              readBefore: o.readBefore ?? "an unknown time",
              details: o.details,
            },
          );
        }
        if (failure) throw new Error(failure);
        const stuck = outcomes.filter((o) => o.status === "error");
        if (stuck.length > 0) {
          throw new Error(
            `${stuck.length} letters were left in Incoming (see ${summaryHandle.name}): ${
              stuck.map((o) => `${o.path}: ${o.error}`).join("; ")
            }`,
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};
