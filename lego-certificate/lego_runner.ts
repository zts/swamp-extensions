/**
 * Runs the lego binary: its version, its DNS provider help, and the run
 * and revoke commands, with a timeout that lets lego clean up first.
 *
 * @module
 */

/** The outcome of one lego process. */
export interface LegoResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Whether the process was stopped because it ran past the timeout. */
  timedOut: boolean;
}

/** Limits for {@link runLego}. */
export interface RunLimits {
  signal: AbortSignal;
  timeoutMs: number;
  /** How long lego gets after SIGTERM before SIGKILL (default 10s). */
  killGraceMs?: number;
}

/** How long lego has between SIGTERM and SIGKILL by default. */
export const KILL_GRACE_MS = 10_000;

const decoder = new TextDecoder();

async function capture(binary: string, args: string[]) {
  try {
    // lego is the ACME client this behavior exists to drive; its argv is
    // built from validated arguments and carries no secret.
    // swamp-quality-ignore deno-command
    const output = await new Deno.Command(binary, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `lego binary '${binary}' was not found; install lego 5 or set ` +
          `legoPath to its location`,
      );
    }
    throw error;
  }
}

/**
 * The version in `lego --version` output, when it is lego 5. Throws for
 * any other major version or unrecognised output.
 */
export function checkVersion(output: string): string {
  const match = output.match(/lego version (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `could not read a lego version from: ${output.trim().slice(0, 200)}`,
    );
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (match[1] !== "5") {
    throw new Error(
      `@zts/lego-certificate needs lego 5, but found lego ${version}`,
    );
  }
  return version;
}

/** Run `<binary> --version` and return the version, requiring lego 5. */
export async function legoVersion(binary: string): Promise<string> {
  const { stdout, stderr } = await capture(binary, ["--version"]);
  return checkVersion(stdout || stderr);
}

/** The variable names in the Credentials section of `lego dnshelp -c`. */
export function parseDnsHelpCredentials(help: string): string[] {
  const section = help.match(/^Credentials:\n((?:[ \t]+-.*\n?)*)/m);
  if (!section) return [];
  return [...section[1].matchAll(/^\s+-\s+"([^"]+)"/gm)].map((m) => m[1]);
}

/** Run `lego dnshelp -c <provider>` and return its credential variables. */
export async function dnsCredentials(
  binary: string,
  provider: string,
): Promise<string[]> {
  const { code, stdout, stderr } = await capture(binary, [
    "dnshelp",
    "-c",
    provider,
  ]);
  if (code !== 0) {
    throw new Error(
      `lego dnshelp -c ${provider} failed: ${(stderr || stdout).trim()}`,
    );
  }
  // Without lego's "Code:" line the output is not the format parsed here,
  // and finding no credentials would wrongly mean none are needed.
  if (!/^Code:\s/m.test(stdout)) {
    throw new Error(
      `could not read the credentials lego dnshelp lists for ${provider}; ` +
        `its output format has changed`,
    );
  }
  return parseDnsHelpCredentials(stdout);
}

/**
 * Whether `env` sets at least one of a provider's credential variables,
 * directly or as lego's `<NAME>_FILE` form. dnshelp lists alternatives and
 * aliases together, so requiring all of them would refuse working setups.
 */
export function hasDnsCredential(
  credentials: string[],
  env: Record<string, string>,
): boolean {
  if (credentials.length === 0) return true;
  return credentials.some((name) => env[name] || env[`${name}_FILE`]);
}

/**
 * Run lego with exactly `env` (nothing else is inherited) and stdin closed.
 * At `timeoutMs` it gets SIGTERM, so it can remove its challenge records,
 * then SIGKILL after the grace period. An abort of `signal` does the same
 * and then rejects with the abort reason.
 */
export async function runLego(
  binary: string,
  args: string[],
  env: Record<string, string>,
  limits: RunLimits,
): Promise<LegoResult> {
  limits.signal.throwIfAborted();
  // lego is the ACME client this behavior exists to drive; secrets reach it
  // only through env, and the environment is cleared first.
  // swamp-quality-ignore deno-command
  const child = new Deno.Command(binary, {
    args,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (killTimer !== undefined) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return; // already exited
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, limits.killGraceMs ?? KILL_GRACE_MS);
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    stop();
  }, limits.timeoutMs);
  limits.signal.addEventListener("abort", stop, { once: true });

  try {
    const output = await child.output();
    limits.signal.throwIfAborted();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    limits.signal.removeEventListener("abort", stop);
  }
}
