// Builds a uv executable for tests: a shell shim that sets the fake's
// controls (see fake_uv.ts) and runs it with this Deno.

/** A fake uv in a temporary directory and the file it logs its calls to. */
export interface FakeUv {
  dir: string;
  uvPath: string;
  callsFile: string;
}

/** One logged call of the fake uv. */
export interface FakeUvCall {
  argv: string[];
  HF_HOME: string | null;
  HF_HUB_OFFLINE: string | null;
  /** The first line of stdin, parsed, for extract-batch. */
  requests: unknown;
}

/** Make a fake uv whose behaviour the given FAKE_UV_* controls set. */
export async function makeFakeUv(
  controls: Record<string, string> = {},
): Promise<FakeUv> {
  const dir = await Deno.makeTempDir({ prefix: "qianfan-ocr-test-" });
  const callsFile = `${dir}/calls.jsonl`;
  const fake = new URL("./fake_uv.ts", import.meta.url).pathname;
  const exports = Object.entries({ FAKE_UV_CALLS: callsFile, ...controls })
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", `'\\''`)}'\n`)
    .join("");
  const uvPath = `${dir}/uv`;
  await Deno.writeTextFile(
    uvPath,
    `#!/bin/sh\n${exports}exec '${Deno.execPath()}' run --quiet --allow-all --no-config '${fake}' "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, uvPath, callsFile };
}

/** The calls the fake uv logged, oldest first. */
export async function fakeUvCalls(fake: FakeUv): Promise<FakeUvCall[]> {
  try {
    return (await Deno.readTextFile(fake.callsFile)).trim().split("\n")
      .filter((line) => line).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
