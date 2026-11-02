/**
 * Runs the Python helper through uv: whether its script environment exists,
 * and one helper subcommand, telling uv's own failures from the helper's.
 *
 * @module
 */

/** The first line the helper writes to stderr; see helper/qianfan_ocr.py. */
export const STARTED = "qianfan-ocr helper started";

/** How to run uv. */
export interface UvSettings {
  uvPath: string;
  /** Passed to the helper as HF_HOME when set. */
  hfHome?: string;
  signal: AbortSignal;
}

/** How to run one helper subcommand. */
export interface RunOptions {
  /** Keep uv and Hugging Face off the network. */
  offline: boolean;
  /** Given the helper's stderr, if any, whether the run succeeds or fails. */
  onStderr?: (stderr: string) => void;
}

const decoder = new TextDecoder();

async function uv(
  settings: UvSettings,
  args: string[],
  env: Record<string, string> = {},
) {
  try {
    // uv runs the Python helper, the way this behavior runs the model outside
    // Deno; its argv is built from validated arguments and carries no secret.
    // swamp-quality-ignore deno-command
    const output = await new Deno.Command(settings.uvPath, {
      args,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: settings.signal,
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `uv: not found at '${settings.uvPath}' (install uv, or set uvPath to its location)`,
      );
    }
    throw error;
  }
}

/**
 * Whether the script's own uv environment exists, without building it.
 * `uv python find --script` (checked on uv 0.12) builds nothing and exits 0
 * either way: it prints the environment's interpreter when there is one, and
 * otherwise some other interpreter outside uv's environments-v2 cache.
 */
export async function environmentExists(
  settings: UvSettings,
  script: string,
): Promise<boolean> {
  const { code, stdout } = await uv(settings, [
    "python",
    "find",
    "--script",
    script,
  ]);
  return code === 0 && stdout.includes("/environments-v2/");
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Run one helper subcommand with `uv run --locked --script`. */
async function uvRun(
  settings: UvSettings,
  script: string,
  args: string[],
  { offline, onStderr }: RunOptions,
) {
  const env: Record<string, string> = {};
  if (settings.hfHome) env.HF_HOME = settings.hfHome;
  if (offline) env.HF_HUB_OFFLINE = "1";
  const run = await uv(settings, [
    "run",
    "--quiet",
    "--locked",
    ...(offline ? ["--offline"] : []),
    "--script",
    script,
    ...args,
  ], env);
  if (run.stderr.trim()) onStderr?.(run.stderr.trim());
  return run;
}

/**
 * Why a run that exited non-zero failed: the helper's own {"error"}, uv
 * failing before the helper started, or the helper dying after it had.
 */
function failure(
  command: string,
  code: number,
  stderr: string,
  offline: boolean,
  result: Record<string, unknown> | null,
): string {
  if (result && typeof result.error === "string") return result.error;
  if (!stderr.includes(STARTED)) {
    return offline
      ? `Python environment is missing or out of date; run install. uv said:\n${
        tail(stderr)
      }`
      : `uv could not run the helper:\n${tail(stderr)}`;
  }
  return `qianfan_ocr.py ${command} failed (exit ${code}):\n${tail(stderr)}`;
}

/**
 * Run one helper subcommand with `uv run --locked --script`. With offline,
 * uv may not reach the network, so an environment that is missing or out of
 * date fails rather than downloads, and Hugging Face stays offline too.
 */
export async function runHelper(
  settings: UvSettings,
  script: string,
  args: string[],
  options: RunOptions,
): Promise<Record<string, unknown>> {
  const { code, stdout, stderr } = await uvRun(
    settings,
    script,
    args,
    options,
  );
  const result = jsonObject(stdout.trim());

  if (code === 0) {
    if (!result) {
      throw new Error(
        `qianfan_ocr.py ${
          args[0]
        } printed something other than one JSON object: ` +
          stdout.trim().slice(0, 200),
      );
    }
    return result;
  }
  throw new Error(failure(args[0], code, stderr, options.offline, result));
}

/** What a helper subcommand that prints JSON lines wrote, and how it ended. */
export interface LinesRun {
  /** Every complete line that held a JSON object, in order. */
  lines: Record<string, unknown>[];
  ok: boolean;
  /** Why the run failed, as runHelper would throw it; null when ok. */
  error: string | null;
}

/**
 * Run a helper subcommand that prints one JSON object per line, as
 * runHelper does, but keep the lines it wrote even when it fails part way:
 * the caller decides what to do with them. A line cut off by the helper
 * dying is dropped. stdout is read when the process exits, so nothing
 * arrives while it runs.
 */
export async function runHelperLines(
  settings: UvSettings,
  script: string,
  args: string[],
  options: RunOptions,
): Promise<LinesRun> {
  const { code, stdout, stderr } = await uvRun(
    settings,
    script,
    args,
    options,
  );
  const complete = stdout.endsWith("\n")
    ? stdout
    : stdout.slice(0, stdout.lastIndexOf("\n") + 1);
  const lines = complete.split("\n").map((line) => jsonObject(line.trim()))
    .filter((line): line is Record<string, unknown> => line !== null);
  if (code === 0) return { lines, ok: true, error: null };
  // The helper's {"error"} comes alone, before any line of results.
  const errorLine = lines.length === 1 && !("type" in lines[0])
    ? lines[0]
    : null;
  return {
    lines: errorLine ? [] : lines,
    ok: false,
    error: failure(args[0], code, stderr, options.offline, errorLine),
  };
}
