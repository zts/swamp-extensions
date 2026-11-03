/**
 * Reads the key details off a scanned letter: renders the top of a PDF page
 * and has @zts/qianfan-ocr read it with a letter prompt, then records the
 * sender, date, recipient, document type and references as typed data.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { MAX_DPI, MIN_DPI, renderTop } from "./render.ts";

/** The document types `documentType` takes; anything else is `other`. */
export const DOCUMENT_TYPES = [
  "bill",
  "statement",
  "invoice",
  "reminder",
  "notice",
  "other",
] as const;

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

/** Most characters of a file stem kept in a record name. */
const MAX_STEM = 64;

const GlobalArgsSchema = z.object({
  ocrBehavior: z.string().regex(NAME).default("qianfan-ocr").describe(
    "Name of the @zts/qianfan-ocr behavior that reads the image; create and install it first",
  ),
});

const ListPdfsArgsSchema = z.object({
  directory: z.string().min(1).describe(
    "Directory of PDFs; absolute, or relative to the repository",
  ),
  run: z.string().regex(NAME).optional().describe(
    "Name the list pdf-list-<run>, so concurrent workflow runs keep their own lists",
  ),
});

/** How each letter is read; scan and scanBatch take the same. */
const ReadArgs = {
  page: z.number().int().min(1).default(1).describe("1-based page to read"),
  fraction: z.number().gt(0).max(1).default(0.25).describe(
    "Share of the page, from the top, to read",
  ),
  dpi: z.number().int().min(MIN_DPI).max(MAX_DPI).default(200).describe(
    "Render resolution",
  ),
  prompt: z.string().min(1).optional().describe(
    "Replace the letter prompt",
  ),
  maxNewTokens: z.number().int().min(1).default(1024).describe(
    "Most tokens the model may generate",
  ),
};

const ScanArgsSchema = z.object({
  pdfPath: z.string().min(1).describe(
    "PDF of a scanned letter; absolute, or relative to the repository",
  ),
  ...ReadArgs,
});

const ScanBatchArgsSchema = z.object({
  pdfPaths: z.array(z.string().min(1)).optional().describe(
    "PDFs of scanned letters; absolute, or relative to the repository",
  ),
  list: z.string().regex(NAME).optional().describe(
    "Read the PDFs listPdfs listed: the run it was given, or the list's full name (pdf-list when it had no run)",
  ),
  ...ReadArgs,
}).refine((a) => (a.pdfPaths === undefined) !== (a.list === undefined), {
  message: "Give exactly one of pdfPaths and list",
});

type ReadOptions = z.infer<typeof ScanArgsSchema>;

const DetailsSchema = z.object({
  pdfPath: z.string(),
  page: z.number(),
  fraction: z.number(),
  dpi: z.number(),
  contentHash: z.string().describe("SHA-256 of the PDF file, in hex"),
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
  loadMs: z.number(),
  generateMs: z.number(),
  scannedAt: z.string(),
});

const PdfListSchema = z.object({
  directory: z.string(),
  files: z.array(z.object({
    path: z.string().describe("Absolute path to the PDF"),
    name: z.string().describe("The name its scan records take"),
  })),
  listedAt: z.string(),
});

const ScanBatchSchema = z.object({
  letters: z.array(z.object({
    path: z.string(),
    name: z.string().nullable().describe(
      "The name its records take; null if the PDF could not be read",
    ),
    status: z.enum(["ok", "error", "notRun"]),
    details: z.string().nullable().describe("The details record written"),
    error: z.string().nullable(),
  })),
  batch: z.object({ name: z.string(), version: z.number() }).nullable()
    .describe("The qianfan-ocr batch record the letters were read from"),
  succeeded: z.number(),
  failed: z.number(),
  notRun: z.number(),
  loadMs: z.number().nullable(),
  error: z.string().nullable().describe(
    "Why the batch failed, if it did; the letters it read are kept",
  ),
  scannedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface Context {
  globalArgs: GlobalArgs;
  definition: { name: string };
  repoDir: string;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
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

/** SHA-256 of the bytes, in lowercase hex. */
export async function contentHash(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The name a PDF's records take: its file stem in safe characters and the
 * first 16 hex of its content hash. Scanning the same file again adds a
 * version; another letter saved under a reused name gets its own record.
 * The stem is cut to MAX_STEM characters so the name stays a valid file name.
 */
export function instanceName(pdfPath: string, hash: string): string {
  const stem = pdfPath.split("/").pop()!.replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, MAX_STEM)
    .replace(/^-+|-+$/g, "");
  return `${stem || "letter"}-${hash.slice(0, 16)}`;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

async function readPdf(path: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`PDF not found: ${path}`);
    }
    throw error;
  }
}

/** Why a call to qianfan-ocr failed, and how to set it up. */
function ocrFailure(ocrBehavior: string, error: { message: string }): string {
  const message = error.message.replace(/\.$/, "");
  // An older qianfan-ocr, from before extractBatch.
  // swamp's runModel and workflow wordings for a method the type lacks.
  if (
    /unknown method 'extractBatch'|method 'extractBatch' not found/i.test(
      message,
    )
  ) {
    return `qianfan-ocr behavior '${ocrBehavior}' failed: ${message}. ` +
      `scanBatch needs @zts/qianfan-ocr 2026.11.03.1 or later: run ` +
      `swamp extension pull @zts/qianfan-ocr, then ` +
      `swamp behavior run ${ocrBehavior} install`;
  }
  return `qianfan-ocr behavior '${ocrBehavior}' failed: ${message}. ` +
    `If it does not exist yet, create and install it: ` +
    `swamp behavior create @zts/qianfan-ocr ${ocrBehavior}, then ` +
    `swamp behavior run ${ocrBehavior} install`;
}

/** A PDF read and its top rendered to a file, ready for qianfan-ocr. */
interface Rendered {
  pdfPath: string;
  hash: string;
  name: string;
  imagePath: string;
}

/** Read a PDF and render the top of a page into dir as <name>.png. */
async function renderToFile(
  context: Context,
  pdfPath: string,
  a: ReadOptions | Omit<ReadOptions, "pdfPath">,
  dir: string,
  pdf?: Uint8Array<ArrayBuffer>,
): Promise<Rendered> {
  const bytes = pdf ?? await readPdf(pdfPath);
  const hash = await contentHash(bytes);
  const name = instanceName(pdfPath, hash);
  const top = await renderTop(bytes, a);
  context.logger.info(
    "Rendered {width}x{height} from page {page} of {pdfPath}",
    { width: top.width, height: top.height, page: a.page, pdfPath },
  );
  const imagePath = `${dir}/${name}.png`;
  await Deno.writeFile(imagePath, top.png);
  return { pdfPath, hash, name, imagePath };
}

/** The details of a letter from the ocr record qianfan-ocr wrote for it. */
function detailsFrom(
  letter: Rendered,
  a: Omit<ReadOptions, "pdfPath">,
  prompt: string,
  ocr: Record<string, unknown>,
  record: { behavior: string; name: string; version: number },
) {
  const parsed = isObject(ocr.parsed) ? ocr.parsed : null;
  return DetailsSchema.parse({
    pdfPath: letter.pdfPath,
    page: a.page,
    fraction: a.fraction,
    dpi: a.dpi,
    contentHash: letter.hash,
    ...toDetails(parsed),
    parsedOk: parsed !== null,
    rawOutput: String(ocr.rawOutput ?? ""),
    prompt,
    ocr: record,
    model: String(ocr.model ?? ""),
    revision: String(ocr.revision ?? ""),
    device: String(ocr.device ?? ""),
    loadMs: Number(ocr.loadMs ?? 0),
    generateMs: Number(ocr.generateMs ?? 0),
    scannedAt: new Date().toISOString(),
  });
}

/** Write a letter's details, then its header image; both handles. */
async function writeLetter(
  context: Context,
  letter: Rendered,
  details: z.infer<typeof DetailsSchema>,
  onDetails?: (handle: DataHandle) => void,
): Promise<{ detailsHandle: DataHandle; headerHandle: DataHandle }> {
  // details first: if its write fails, no header is left without it.
  const detailsHandle = await context.writeResource(
    "details",
    `details-${letter.name}`,
    details,
  );
  onDetails?.(detailsHandle);
  const headerHandle = await context
    .createFileWriter("header", `header-${letter.name}`)
    .writeAll(await Deno.readFile(letter.imagePath));
  // The letter's contents stay out of the logs.
  context.logger.info(
    "Wrote {name}: {documentType}, parsed JSON: {parsedOk}",
    {
      name: detailsHandle.name,
      documentType: details.documentType,
      parsedOk: details.parsedOk,
    },
  );
  return { detailsHandle, headerHandle };
}

/** The newest version of a record, or undefined. */
function latest<T extends { version?: number }>(records: T[]): T | undefined {
  return records.reduce<T | undefined>(
    (best, r) => (best && (best.version ?? 0) >= (r.version ?? 0) ? best : r),
    undefined,
  );
}

/** The PDF paths of a list listPdfs wrote under this behavior instance. */
async function listedPaths(context: Context, list: string): Promise<string[]> {
  const name = list === "pdf-list" || list.startsWith("pdf-list-")
    ? list
    : `pdf-list-${list}`;
  const model = context.definition.name;
  const records = await context.queryData(
    `modelName == "${model}" && name == "${name}"`,
  ) as { version?: number; attributes?: Record<string, unknown> }[];
  const record = latest(records);
  if (!record?.attributes) {
    throw new Error(
      `No list ${name} on ${model}: run listPdfs on ${model} first`,
    );
  }
  return PdfListSchema.parse(record.attributes).files.map((f) => f.path);
}

/** Run qianfan-ocr's extract on an image; the record it wrote. */
async function extract(
  context: Context,
  ocrBehavior: string,
  args: Record<string, unknown>,
): Promise<{ handle: DataHandle; attributes: Record<string, unknown> }> {
  const result = await context.runModel({
    definition: ocrBehavior,
    method: "extract",
    arguments: args,
  });
  if (!result.ok) throw new Error(ocrFailure(ocrBehavior, result.error));
  const handle = result.resources.find((r) => r.specName === "ocr");
  if (!handle || handle.version === undefined) {
    throw new Error(
      `qianfan-ocr behavior '${ocrBehavior}' wrote no ocr record`,
    );
  }
  // The version extract wrote, not the latest: another scan may follow it.
  const records = await context.queryData(
    `modelName == "${ocrBehavior}" && name == "${handle.name}" && version == ${handle.version}`,
  ) as { attributes?: Record<string, unknown> }[];
  const attributes = records[0]?.attributes;
  if (!attributes) {
    throw new Error(
      `qianfan-ocr wrote ${handle.name} version ${handle.version}, but it is no longer there to read`,
    );
  }
  return { handle, attributes };
}

/** The @zts/classify-post-pdf behavior. */
export const behavior = {
  type: "@zts/classify-post-pdf",
  version: "2026.11.03.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.03.1",
      description: "Adds scanBatch; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "details": {
      description: "Key details read from the top of a scanned letter",
      schema: DetailsSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "pdfList": {
      description: "PDFs found in a directory, for a workflow to scan",
      schema: PdfListSchema,
      // Each workflow run writes its own list and reads it seconds later.
      lifetime: "7d",
      garbageCollection: 10,
    },
    "scanBatch": {
      description:
        "One scanBatch: each letter's outcome and the details record it wrote",
      schema: ScanBatchSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  files: {
    "header": {
      description: "The rendered region of the letter that was read",
      contentType: "image/png",
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    listPdfs: {
      description:
        "List the PDFs in a directory (not recursive), sorted, with the names their scans take",
      arguments: ListPdfsArgsSchema,
      execute: async (
        args: z.input<typeof ListPdfsArgsSchema>,
        context: Context,
      ) => {
        const a = ListPdfsArgsSchema.parse(args);
        const directory = resolve(context.repoDir, a.directory);
        const files: { path: string; name: string }[] = [];
        for await (const entry of Deno.readDir(directory)) {
          if (!/\.pdf$/i.test(entry.name)) continue;
          const path = `${directory}/${entry.name}`;
          if (entry.isSymlink) {
            const target = await Deno.stat(path).catch(() => null);
            if (!target) {
              context.logger.warning("Skipping {path}: its link is broken", {
                path,
              });
              continue;
            }
            if (!target.isFile) continue;
          } else if (!entry.isFile) continue;
          const hash = await contentHash(await Deno.readFile(path));
          files.push({ path, name: instanceName(path, hash) });
        }
        files.sort((x, y) => x.path.localeCompare(y.path));
        // Two files share a record only when they hold the same bytes under
        // names that clean up alike, so scanning one of them is enough.
        const byName = new Map<string, string>();
        const unique = files.filter((f) => {
          const kept = byName.get(f.name);
          if (kept) {
            context.logger.warning(
              "Skipping {skipped}: same contents as {kept}, so it would share record {name}",
              { skipped: f.path, kept, name: f.name },
            );
            return false;
          }
          byName.set(f.name, f.path);
          return true;
        });
        const listName = a.run ? `pdf-list-${a.run}` : "pdf-list";
        const handle = await context.writeResource("pdfList", listName, {
          directory,
          files: unique,
          listedAt: new Date().toISOString(),
        });
        context.logger.info("Found {count} PDFs in {directory}", {
          count: unique.length,
          directory,
        });
        return { dataHandles: [handle] };
      },
    },
    scan: {
      description:
        "Read sender, date, recipient, document type and references off the top of a letter with qianfan-ocr",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.input<typeof ScanArgsSchema>,
        context: Context,
      ) => {
        const a = ScanArgsSchema.parse(args);
        const { ocrBehavior } = GlobalArgsSchema.parse(context.globalArgs);
        const pdfPath = resolve(context.repoDir, a.pdfPath);
        const pdf = await readPdf(pdfPath);

        // qianfan-ocr reads a file, so the image lives in a temp dir until
        // it has; the header file below is the copy that is kept.
        const tmpDir = await Deno.makeTempDir({ prefix: "classify-post-pdf-" });
        try {
          const letter = await renderToFile(context, pdfPath, a, tmpDir, pdf);
          const prompt = a.prompt ?? DEFAULT_PROMPT;
          const { handle, attributes: ocr } = await extract(
            context,
            ocrBehavior,
            {
              imagePath: letter.imagePath,
              prompt,
              maxNewTokens: a.maxNewTokens,
              name: letter.name,
            },
          );
          const details = detailsFrom(letter, a, prompt, ocr, {
            behavior: ocrBehavior,
            name: handle.name,
            version: handle.version!,
          });
          const { detailsHandle, headerHandle } = await writeLetter(
            context,
            letter,
            details,
          );
          return { dataHandles: [headerHandle, detailsHandle] };
        } finally {
          await Deno.remove(tmpDir, { recursive: true });
        }
      },
    },
    scanBatch: {
      description:
        "Read many letters with one load of the OCR model, from a list of PDFs or a listPdfs list",
      arguments: ScanBatchArgsSchema,
      execute: async (
        args: z.input<typeof ScanBatchArgsSchema>,
        context: Context,
      ) => {
        const a = ScanBatchArgsSchema.parse(args);
        const { ocrBehavior } = GlobalArgsSchema.parse(context.globalArgs);
        const paths = a.list !== undefined
          ? await listedPaths(context, a.list)
          : a.pdfPaths!.map((p) => resolve(context.repoDir, p));
        const prompt = a.prompt ?? DEFAULT_PROMPT;
        // One base name for the call: qianfan-ocr's batch-<base> and our
        // scan-batch-<base>.
        const base = `${
          a.list ?? new Date().toISOString().replace(/[-:.]/g, "")
        }-${crypto.randomUUID().slice(0, 8)}`;

        type Letter = z.infer<typeof ScanBatchSchema>["letters"][number];
        const letters: Letter[] = [];
        const rendered = new Map<Letter, Rendered>();
        const handles: DataHandle[] = [];
        let batch: z.infer<typeof ScanBatchSchema>["batch"] = null;
        let loadMs: number | null = null;
        // Why the batch failed; thrown once everything is written.
        let failure: string | null = null;

        const tmpDir = await Deno.makeTempDir({ prefix: "classify-post-pdf-" });
        try {
          const byName = new Map<string, string>();
          for (const pdfPath of paths) {
            try {
              const letter = await renderToFile(context, pdfPath, a, tmpDir);
              // extractBatch refuses two items with one record name.
              const kept = byName.get(letter.name);
              if (kept) {
                context.logger.warning(
                  "Skipping {skipped}: same contents as {kept}, so it would share record {name}",
                  { skipped: pdfPath, kept, name: letter.name },
                );
                continue;
              }
              byName.set(letter.name, pdfPath);
              const entry: Letter = {
                path: pdfPath,
                name: letter.name,
                status: "notRun",
                details: null,
                error: null,
              };
              letters.push(entry);
              rendered.set(entry, letter);
            } catch (error) {
              letters.push({
                path: pdfPath,
                name: null,
                status: "error",
                details: null,
                error: errorMessage(error),
              });
            }
          }

          const sent = letters.filter((l) => rendered.has(l));
          if (sent.length > 0) {
            const result = await context.runModel({
              definition: ocrBehavior,
              method: "extractBatch",
              arguments: {
                items: sent.map((l) => ({
                  imagePath: rendered.get(l)!.imagePath,
                  prompt,
                  name: l.name,
                })),
                maxNewTokens: a.maxNewTokens,
                // qianfan-ocr adds the batch- prefix.
                name: base,
              },
            });
            // extractBatch fails part way after writing its batch record,
            // and runModel then returns no handles, so look it up by name.
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
              failure = result.ok
                ? `qianfan-ocr behavior '${ocrBehavior}' wrote no batch record`
                : ocrFailure(ocrBehavior, result.error);
            } else {
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
              batch = { name: record.name, version: record.version };
              loadMs = read.loadMs ?? null;
              if (read.error) {
                failure =
                  `qianfan-ocr's batch ${record.name} failed part way: ${read.error}`;
              } else if (!result.ok) {
                failure = ocrFailure(ocrBehavior, result.error);
              }
              // Items are in the order sent; anything else is a qianfan bug,
              // and guessing which letter an item belongs to would misfile it.
              const mismatch =
                `qianfan-ocr's batch ${record.name} does not match what was sent`;
              if (read.items.length !== sent.length) {
                failure ??=
                  `${mismatch}: ${read.items.length} items for ${sent.length} letters`;
              }
              for (const [i, letter] of sent.entries()) {
                const item = read.items[i];
                if (!item) {
                  letter.status = "error";
                  letter.error = `${mismatch}: no item for this letter`;
                  continue;
                }
                if (
                  item.status === "ok" && item.record !== `ocr-${letter.name}`
                ) {
                  letter.status = "error";
                  letter.error =
                    `${mismatch}: its item names ${item.record}, not ocr-${letter.name}`;
                  failure ??= `${mismatch}: ${letter.path} got ${item.record}`;
                  continue;
                }
                if (item.status !== "ok") {
                  letter.status = item.status;
                  letter.error = item.error;
                  continue;
                }
                try {
                  // The version this batch wrote, never the latest.
                  const ocr = await context.queryData(
                    `modelName == "${ocrBehavior}" && name == "${item.record}" && version == ${item.recordVersion}`,
                  ) as { attributes?: Record<string, unknown> }[];
                  if (!ocr[0]?.attributes) {
                    throw new Error(
                      `qianfan-ocr wrote ${item.record} version ${item.recordVersion}, but it is no longer there to read`,
                    );
                  }
                  const letterRendered = rendered.get(letter)!;
                  const details = detailsFrom(
                    letterRendered,
                    a,
                    prompt,
                    ocr[0].attributes,
                    {
                      behavior: ocrBehavior,
                      name: item.record!,
                      version: item.recordVersion!,
                    },
                  );
                  const written = await writeLetter(
                    context,
                    letterRendered,
                    details,
                    // Named even if the header write then fails.
                    (handle) => {
                      handles.push(handle);
                      letter.details = handle.name;
                    },
                  );
                  handles.push(written.headerHandle);
                  letter.status = "ok";
                } catch (error) {
                  letter.status = "error";
                  letter.error = errorMessage(error);
                }
              }
            }
          }
        } finally {
          await Deno.remove(tmpDir, { recursive: true });
        }

        const count = (status: Letter["status"]) =>
          letters.filter((l) => l.status === status).length;
        const summary = ScanBatchSchema.parse({
          letters,
          batch,
          succeeded: count("ok"),
          failed: count("error"),
          notRun: count("notRun"),
          loadMs,
          error: failure,
          scannedAt: new Date().toISOString(),
        });
        const summaryHandle = await context.writeResource(
          "scanBatch",
          `scan-batch-${base}`,
          summary,
        );
        handles.push(summaryHandle);
        context.logger.info(
          "Wrote {name}: {succeeded} read, {failed} failed, {notRun} not run",
          {
            name: summaryHandle.name,
            succeeded: summary.succeeded,
            failed: summary.failed,
            notRun: summary.notRun,
          },
        );
        if (failure) throw new Error(failure);
        if (letters.length > 0 && summary.succeeded === 0) {
          throw new Error(
            `none of the ${letters.length} letters was read (see ${summaryHandle.name}): ${
              letters.map((l) => `${l.path}: ${l.error ?? l.status}`).join("; ")
            }`,
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};
