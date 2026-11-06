/**
 * Finds and stops the helper that holds the machine-wide model lock, from
 * the holder.json it writes beside model.lock (see helper/qianfan_ocr.py).
 * A helper that was killed leaves holder.json behind, so the record is only
 * believed while its PID is a live qianfan_ocr.py process.
 *
 * @module
 */

/** What a helper records about itself once it holds the model lock. */
export interface Holder {
  pid: number;
  parentPid?: number;
  startedAt?: string;
  command?: string | null;
  batchId?: string | null;
}

/** What stop found and did. */
export interface StopResult {
  /**
   * running: a live helper held the lock; stale: holder.json names a process
   * that is gone or is not a helper; none: there is no holder.json.
   */
  found: "running" | "stale" | "none";
  holder: Holder | null;
  stopped: boolean;
  /** The last signal sent to the helper; null when none was. */
  signal: "SIGTERM" | "SIGKILL" | null;
}

const decoder = new TextDecoder();

/** holder.json under XDG_CACHE_HOME, else ~/.cache, as the helper puts it. */
export function holderPath(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const cache = env.XDG_CACHE_HOME || `${env.HOME}/.cache`;
  return `${cache}/qianfan-ocr/holder.json`;
}

async function readHolder(path: string): Promise<Holder | null> {
  try {
    const holder = JSON.parse(await Deno.readTextFile(path));
    return holder && typeof holder === "object" &&
        Number.isInteger(holder.pid) && holder.pid > 0
      ? holder
      : null;
  } catch {
    return null;
  }
}

/** pid's state and command line from ps; null when there is no such process. */
async function processInfo(
  pid: number,
): Promise<{ state: string; command: string } | null> {
  // ps reads one process's state and command line, so stop never signals a
  // PID the OS has given to something other than a helper; the argv is a
  // number and fixed flags.
  // swamp-quality-ignore deno-command
  const { code, stdout } = await new Deno.Command("ps", {
    args: ["-o", "stat=,command=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  const line = decoder.decode(stdout).trim();
  if (code !== 0 || !line) return null;
  const [state, ...command] = line.split(/\s+/);
  return { state, command: command.join(" ") };
}

/** Whether pid is a live (not zombie) process running qianfan_ocr.py. */
async function isHelper(pid: number): Promise<boolean> {
  const info = await processInfo(pid);
  return info !== null && !info.state.startsWith("Z") &&
    info.command.includes("qianfan_ocr.py");
}

async function gone(pid: number): Promise<boolean> {
  const info = await processInfo(pid);
  return info === null || info.state.startsWith("Z");
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await gone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await gone(pid);
}

function signal(pid: number, sig: "SIGTERM" | "SIGKILL") {
  try {
    Deno.kill(pid, sig);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * Stop the helper holding the model lock: SIGTERM it and its uv parent
 * (only if that is a qianfan helper's uv too), then SIGKILL the helper if
 * it is still there after graceMs. The kernel frees the lock when the
 * helper exits. holder.json is left as it is: the next helper overwrites
 * it, and removing it here could remove that helper's record.
 */
export async function stopHolder(
  path: string,
  { graceMs = 10_000 }: { graceMs?: number } = {},
): Promise<StopResult> {
  const holder = await readHolder(path);
  if (!holder) {
    return { found: "none", holder: null, stopped: false, signal: null };
  }
  if (!await isHelper(holder.pid)) {
    return { found: "stale", holder, stopped: false, signal: null };
  }
  const parent = holder.parentPid && await isHelper(holder.parentPid)
    ? holder.parentPid
    : null;
  signal(holder.pid, "SIGTERM");
  if (parent) signal(parent, "SIGTERM");
  if (await waitGone(holder.pid, graceMs)) {
    return { found: "running", holder, stopped: true, signal: "SIGTERM" };
  }
  signal(holder.pid, "SIGKILL");
  if (parent) signal(parent, "SIGKILL");
  return {
    found: "running",
    holder,
    stopped: await waitGone(holder.pid, 5_000),
    signal: "SIGKILL",
  };
}
