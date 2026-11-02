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

const ScanArgsSchema = z.object({
  pdfPath: z.string().min(1).describe(
    "PDF of a scanned letter; absolute, or relative to the repository",
  ),
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
});

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

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface Context {
  globalArgs: GlobalArgs;
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
  if (!result.ok) {
    throw new Error(
      `qianfan-ocr behavior '${ocrBehavior}' failed: ${
        result.error.message.replace(/\.$/, "")
      }. ` +
        `If it does not exist yet, create and install it: ` +
        `swamp behavior create @zts/qianfan-ocr ${ocrBehavior}, then ` +
        `swamp behavior run ${ocrBehavior} install`,
    );
  }
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
  version: "2026.11.02.1",
  globalArguments: GlobalArgsSchema,
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
      lifetime: "infinite",
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
        const hash = await contentHash(pdf);
        const name = instanceName(pdfPath, hash);
        const top = await renderTop(pdf, a);
        context.logger.info(
          "Rendered {width}x{height} from page {page} of {pdfPath}",
          { width: top.width, height: top.height, page: a.page, pdfPath },
        );

        // qianfan-ocr reads a file, so the image lives in a temp dir until
        // it has; the header file below is the copy that is kept.
        const tmpDir = await Deno.makeTempDir({ prefix: "classify-post-pdf-" });
        try {
          const imagePath = `${tmpDir}/${name}.png`;
          await Deno.writeFile(imagePath, top.png);
          const prompt = a.prompt ?? DEFAULT_PROMPT;
          const { handle, attributes: ocr } = await extract(
            context,
            ocrBehavior,
            { imagePath, prompt, maxNewTokens: a.maxNewTokens, name },
          );
          const parsed = isObject(ocr.parsed) ? ocr.parsed : null;
          const details = DetailsSchema.parse({
            pdfPath,
            page: a.page,
            fraction: a.fraction,
            dpi: a.dpi,
            contentHash: hash,
            ...toDetails(parsed),
            parsedOk: parsed !== null,
            rawOutput: String(ocr.rawOutput ?? ""),
            prompt,
            ocr: {
              behavior: ocrBehavior,
              name: handle.name,
              version: handle.version,
            },
            model: String(ocr.model ?? ""),
            revision: String(ocr.revision ?? ""),
            device: String(ocr.device ?? ""),
            loadMs: Number(ocr.loadMs ?? 0),
            generateMs: Number(ocr.generateMs ?? 0),
            scannedAt: new Date().toISOString(),
          });
          // details first: if its write fails, no header is left without it.
          const detailsHandle = await context.writeResource(
            "details",
            `details-${name}`,
            details,
          );
          const headerHandle = await context
            .createFileWriter("header", `header-${name}`)
            .writeAll(top.png);
          // The letter's contents stay out of the logs.
          context.logger.info(
            "Wrote {name}: {documentType}, parsed JSON: {parsedOk}",
            {
              name: detailsHandle.name,
              documentType: details.documentType,
              parsedOk: details.parsedOk,
            },
          );
          return { dataHandles: [headerHandle, detailsHandle] };
        } finally {
          await Deno.remove(tmpDir, { recursive: true });
        }
      },
    },
  },
};
