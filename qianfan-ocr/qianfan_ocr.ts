/**
 * Runs the Qianfan-OCR vision-language model locally on one image, through
 * a Python helper that uv runs, so torch and transformers stay out of Deno.
 * install builds the helper's environment and downloads the model; extract
 * never downloads either.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { environmentExists, runHelper, type UvSettings } from "./uv_runner.ts";

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
  name: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe(
    "Name of the ocr resource, after ocr-; default the image file's stem",
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
  ) => Promise<{ name: string }>;
}

function uvSettings(context: Context): UvSettings {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  return { uvPath: g.uvPath, hfHome: g.hfHome, signal: context.signal };
}

function logHelper(context: Context) {
  return (stderr: string) =>
    context.logger.info("helper: {stderr}", { stderr });
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
  version: "2026.11.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "ocr": {
      description: "What the model read from one image, and how long it took",
      schema: OcrSchema,
      lifetime: "infinite",
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
        const image = a.imagePath.startsWith("/")
          ? a.imagePath
          : `${context.repoDir}/${a.imagePath}`;
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
        return { dataHandles: [handle] };
      },
    },
  },
};
