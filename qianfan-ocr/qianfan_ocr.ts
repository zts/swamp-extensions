/**
 * Runs the Qianfan-OCR vision-language model locally on images, through a
 * Python helper that uv runs, so torch and transformers stay out of Deno.
 * install builds the helper's environment and downloads the model; extract
 * reads one image and extractBatch many with one model load, and neither
 * ever downloads.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  environmentExists,
  runHelper,
  runHelperLines,
  type UvSettings,
} from "./uv_runner.ts";

/** The Hugging Face model the behavior runs by default. */
export const DEFAULT_MODEL = "baidu/Qianfan-OCR";

/**
 * baidu/Qianfan-OCR's main branch as of 2026-04-29, so one extension version
 * always runs the same weights. Keep in step with helper/qianfan_ocr.py.
 */
export const DEFAULT_REVISION = "623bf5d20d446abdb36606aa4547cd0c18886fe5";

const HELPER = "helper/qianfan_ocr.py";

const GlobalArgsSchema = z.object({
  uvPath: z.string().min(1).default("uv").describe(
    "uv executable that runs the Python helper (absolute path if not on PATH)",
  ),
  hfHome: z.string().min(1).optional().describe(
    "Hugging Face cache directory (HF_HOME); default Hugging Face's own",
  ),
});

const ModelArgs = {
  model: z.string().min(1).default(DEFAULT_MODEL).describe(
    "Hugging Face model id",
  ),
  revision: z.string().min(1).default(DEFAULT_REVISION).describe(
    "Model revision (commit sha) to run; the default is pinned per release",
  ),
};

const InstallArgsSchema = z.object(ModelArgs);

const NAME = /^[A-Za-z0-9_-]+$/;

const ExtractArgsSchema = z.object({
  imagePath: z.string().min(1).describe(
    "Image to read; absolute, or relative to the repository",
  ),
  prompt: z.string().min(1).describe(
    "What to ask the model, e.g. to transcribe the text or return JSON fields",
  ),
  maxNewTokens: z.number().int().min(1).default(1024).describe(
    "Most tokens the model may generate",
  ),
  ...ModelArgs,
  name: z.string().regex(NAME).optional().describe(
    "Name of the ocr resource, after ocr-; default the image file's stem",
  ),
});

const ExtractBatchArgsSchema = z.object({
  items: z.array(z.object({
    imagePath: z.string().min(1).describe(
      "Image to read; absolute, or relative to the repository",
    ),
    prompt: z.string().min(1).describe("What to ask the model of this image"),
    name: z.string().regex(NAME).optional().describe(
      "Name of its ocr resource, after ocr-; default the image file's stem",
    ),
  })).min(1).describe("The images to read, in order"),
  maxNewTokens: z.number().int().min(1).default(1024).describe(
    "Most tokens the model may generate, for each image",
  ),
  ...ModelArgs,
  name: z.string().regex(NAME).optional().describe(
    "Name of the batch resource, after batch-; default the time the batch started",
  ),
});

const OcrSchema = z.object({
  image: z.string(),
  prompt: z.string(),
  rawOutput: z.string().describe("The model's answer, as generated"),
  parsed: z.record(z.string(), z.unknown()).nullable().describe(
    "The JSON object in rawOutput, if there was one",
  ),
  parsedOk: z.boolean(),
  model: z.string(),
  revision: z.string(),
  device: z.string(),
  dtype: z.string(),
  lockWaitMs: z.number().describe("Time spent waiting for another run's turn"),
  loadMs: z.number(),
  generateMs: z.number(),
  extractedAt: z.string(),
});

const BatchSchema = z.object({
  model: z.string(),
  revision: z.string(),
  device: z.string().nullable(),
  dtype: z.string().nullable(),
  lockWaitMs: z.number().nullable(),
  loadMs: z.number().nullable(),
  totalMs: z.number(),
  items: z.array(z.object({
    image: z.string(),
    prompt: z.string(),
    status: z.enum(["ok", "error", "notRun"]),
    record: z.string().nullable().describe(
      "The ocr resource this batch wrote for the image; null unless ok",
    ),
    recordVersion: z.number().nullable(),
    error: z.string().nullable(),
    generateMs: z.number().nullable(),
  })),
  succeeded: z.number(),
  failed: z.number(),
  notRun: z.number(),
  error: z.string().nullable().describe(
    "Why the helper failed part way, if it did",
  ),
  startedAt: z.string(),
});

const InstallSchema = z.object({
  model: z.string(),
  revision: z.string(),
  environmentExisted: z.boolean().describe(
    "The helper's Python environment existed before install ran",
  ),
  modelAlreadyCached: z.boolean(),
  alreadyInstalled: z.boolean(),
  installedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Logger {
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
}

interface Context {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal: AbortSignal;
  logger: Logger;
  extensionFile: (path: string) => string;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string; version?: number }>;
}

function uvSettings(context: Context): UvSettings {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  return { uvPath: g.uvPath, hfHome: g.hfHome, signal: context.signal };
}

function logHelper(context: Context) {
  return (line: string) => context.logger.info("helper: {line}", { line });
}

/**
 * The ocr resource name for an image: ocr- and the given name, or else the
 * image file's stem in safe characters. The prefix keeps ocr results apart
 * from the install record, which swamp stores under the same instance names.
 */
export function instanceName(imagePath: string, name?: string): string {
  const stem = imagePath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return `ocr-${
    name ??
      (stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
        "image")
  }`;
}

function resolveImage(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/** The default batch name: the time, to the millisecond, in safe characters. */
function batchName(at: Date): string {
  return at.toISOString().replace(/[:.]/g, "-");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The @zts/qianfan-ocr behavior. */
export const behavior = {
  type: "@zts/qianfan-ocr",
  version: "2026.11.03.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.03.1",
      description: "Adds extractBatch; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "ocr": {
      description: "What the model read from one image, and how long it took",
      schema: OcrSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "batch": {
      description:
        "One extractBatch: each image's outcome and the ocr record it wrote",
      schema: BatchSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    "install": {
      description:
        "The last install: model revision and what was already there",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    install: {
      description:
        "Build the Python environment and download the model; skips what is already there",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.input<typeof InstallArgsSchema>,
        context: Context,
      ) => {
        const a = InstallArgsSchema.parse(args);
        const settings = uvSettings(context);
        const script = context.extensionFile(HELPER);
        context.logger.info("Installing {model}@{revision}", {
          model: a.model,
          revision: a.revision,
        });
        const environmentExisted = await environmentExists(settings, script);
        const result = await runHelper(settings, script, [
          "install",
          `--model=${a.model}`,
          `--revision=${a.revision}`,
        ], { offline: false, onStderr: logHelper(context) });
        const modelAlreadyCached = result.modelAlreadyCached === true;
        const handle = await context.writeResource("install", "install", {
          model: a.model,
          revision: a.revision,
          environmentExisted,
          modelAlreadyCached,
          alreadyInstalled: environmentExisted && modelAlreadyCached,
          installedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Installed {model}@{revision} (environment existed: {environmentExisted}, model already cached: {modelAlreadyCached})",
          {
            model: a.model,
            revision: a.revision,
            environmentExisted,
            modelAlreadyCached,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    extract: {
      description:
        "Read one image with the model and a prompt; never downloads (run install first)",
      arguments: ExtractArgsSchema,
      execute: async (
        args: z.input<typeof ExtractArgsSchema>,
        context: Context,
      ) => {
        const a = ExtractArgsSchema.parse(args);
        const image = resolveImage(context.repoDir, a.imagePath);
        if (!await isFile(image)) throw new Error(`image not found: ${image}`);

        context.logger.info("Reading {image} with {model}@{revision}", {
          image,
          model: a.model,
          revision: a.revision,
        });
        // Values go as --flag=value, so one starting with "-" stays a value.
        const result = await runHelper(
          uvSettings(context),
          context.extensionFile(HELPER),
          [
            "extract",
            `--image=${image}`,
            `--prompt=${a.prompt}`,
            `--model=${a.model}`,
            `--revision=${a.revision}`,
            `--max-new-tokens=${a.maxNewTokens}`,
          ],
          { offline: true, onStderr: logHelper(context) },
        );
        const parsed = result.parsed && typeof result.parsed === "object" &&
            !Array.isArray(result.parsed)
          ? result.parsed as Record<string, unknown>
          : null;
        const handle = await context.writeResource(
          "ocr",
          instanceName(image, a.name),
          OcrSchema.parse({
            image,
            prompt: a.prompt,
            rawOutput: result.rawOutput,
            parsed,
            parsedOk: parsed !== null,
            model: a.model,
            revision: a.revision,
            device: result.device,
            dtype: result.dtype,
            lockWaitMs: result.lockWaitMs,
            loadMs: result.loadMs,
            generateMs: result.generateMs,
            extractedAt: new Date().toISOString(),
          }),
        );
        context.logger.info(
          "Wrote {name} on {device}: waited {lockWaitMs}ms, loaded in {loadMs}ms, generated in {generateMs}ms, parsed JSON: {parsedOk}",
          {
            name: handle.name,
            device: result.device,
            lockWaitMs: result.lockWaitMs,
            loadMs: result.loadMs,
            generateMs: result.generateMs,
            parsedOk: parsed !== null,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    extractBatch: {
      description:
        "Read many images with one load of the model; never downloads (run install first)",
      arguments: ExtractBatchArgsSchema,
      execute: async (
        args: z.input<typeof ExtractBatchArgsSchema>,
        context: Context,
      ) => {
        const a = ExtractBatchArgsSchema.parse(args);
        const started = new Date();
        const items = a.items.map((item) => {
          const image = resolveImage(context.repoDir, item.imagePath);
          return {
            image,
            prompt: item.prompt,
            name: instanceName(image, item.name),
          };
        });
        const names = new Map<string, string>();
        for (const item of items) {
          const other = names.get(item.name);
          if (other) {
            throw new Error(
              `${other} and ${item.image} would both be recorded as ${item.name}; give one a name`,
            );
          }
          names.set(item.name, item.image);
        }

        type Outcome = z.infer<typeof BatchSchema>["items"][number];
        const outcomes: Outcome[] = items.map((item) => ({
          image: item.image,
          prompt: item.prompt,
          status: "notRun",
          record: null,
          recordVersion: null,
          error: null,
          generateMs: null,
        }));
        const sent: number[] = [];
        for (const [i, item] of items.entries()) {
          if (await isFile(item.image)) sent.push(i);
          else {
            outcomes[i].status = "error";
            outcomes[i].error = `image not found: ${item.image}`;
          }
        }

        const handles: { name: string; version?: number }[] = [];
        let start: Record<string, unknown> | undefined;
        let failure: string | null = null;
        if (sent.length > 0) {
          context.logger.info(
            "Reading {count} images with {model}@{revision}",
            { count: sent.length, model: a.model, revision: a.revision },
          );
          const tmpDir = await Deno.makeTempDir({ prefix: "qianfan-ocr-" });
          let run;
          try {
            const requests = `${tmpDir}/requests.json`;
            await Deno.writeTextFile(
              requests,
              JSON.stringify(sent.map((i) => ({
                id: String(i),
                image: items[i].image,
                prompt: items[i].prompt,
                maxNewTokens: a.maxNewTokens,
              }))),
            );
            run = await runHelperLines(
              uvSettings(context),
              context.extensionFile(HELPER),
              [
                "extract-batch",
                `--requests=${requests}`,
                `--model=${a.model}`,
                `--revision=${a.revision}`,
              ],
              { offline: true, onStderr: logHelper(context) },
            );
          } finally {
            // A temp dir left behind must not hide what the helper read.
            await Deno.remove(tmpDir, { recursive: true }).catch((error) =>
              context.logger.warning(
                "Could not remove the batch's temp dir {tmpDir}: {error}",
                { tmpDir, error: String(error) },
              )
            );
          }
          const results = run.lines.filter((l) => l.type === "item");
          // Before any item, a failure leaves nothing to keep, as in extract.
          if (!run.ok && results.length === 0) throw new Error(run.error!);
          failure = run.error;
          start = run.lines.find((l) => l.type === "start");

          const byId = new Map(results.map((l) => [String(l.id), l]));
          for (const i of sent) {
            const line = byId.get(String(i));
            if (!line) continue;
            if (typeof line.error === "string") {
              outcomes[i].status = "error";
              outcomes[i].error = line.error;
              continue;
            }
            const parsed = line.parsed && typeof line.parsed === "object" &&
                !Array.isArray(line.parsed)
              ? line.parsed as Record<string, unknown>
              : null;
            const record = OcrSchema.safeParse({
              image: items[i].image,
              prompt: items[i].prompt,
              rawOutput: line.rawOutput,
              parsed,
              parsedOk: parsed !== null,
              model: a.model,
              revision: a.revision,
              device: start?.device,
              dtype: start?.dtype,
              lockWaitMs: start?.lockWaitMs,
              loadMs: start?.loadMs,
              generateMs: line.generateMs,
              extractedAt: new Date().toISOString(),
            });
            // Only a helper bug gets here; failing would strand the records
            // already written without the batch record that names them.
            if (!record.success) {
              outcomes[i].status = "error";
              outcomes[i].error = `the helper printed a malformed result: ${
                z.prettifyError(record.error).replaceAll("\n", " ")
              }`;
              continue;
            }
            const handle = await context.writeResource(
              "ocr",
              items[i].name,
              record.data,
            );
            handles.push(handle);
            Object.assign(outcomes[i], {
              status: "ok",
              record: handle.name,
              recordVersion: handle.version ?? null,
              generateMs: line.generateMs,
            });
          }
          if (run.ok) {
            const missing = sent.filter((i) => outcomes[i].status === "notRun")
              .length;
            if (missing > 0) {
              failure =
                `qianfan_ocr.py extract-batch left out ${missing} item(s)`;
            } else if (!run.lines.some((l) => l.type === "end")) {
              failure =
                "qianfan_ocr.py extract-batch stopped before its end line";
            }
          }
        }

        const count = (status: Outcome["status"]) =>
          outcomes.filter((o) => o.status === status).length;
        const batch = BatchSchema.parse({
          model: a.model,
          revision: a.revision,
          device: start?.device ?? null,
          dtype: start?.dtype ?? null,
          lockWaitMs: start?.lockWaitMs ?? null,
          loadMs: start?.loadMs ?? null,
          totalMs: Date.now() - started.getTime(),
          items: outcomes,
          succeeded: count("ok"),
          failed: count("error"),
          notRun: count("notRun"),
          error: failure,
          startedAt: started.toISOString(),
        });
        const batchHandle = await context.writeResource(
          "batch",
          `batch-${a.name ?? batchName(started)}`,
          batch,
        );
        handles.push(batchHandle);
        context.logger.info(
          "Wrote {name}: {succeeded} read, {failed} failed, {notRun} not run",
          {
            name: batchHandle.name,
            succeeded: batch.succeeded,
            failed: batch.failed,
            notRun: batch.notRun,
          },
        );
        if (batch.succeeded === 0) {
          context.logger.warning(
            "No item in {name} was read: {failed} failed, {notRun} not run",
            {
              name: batchHandle.name,
              failed: batch.failed,
              notRun: batch.notRun,
            },
          );
        }
        // The records above stay written: read the batch record to tell
        // which ocr records this batch wrote.
        if (failure) throw new Error(failure);
        return { dataHandles: handles };
      },
    },
  },
};
