import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { holderPath, stopHolder } from "./lock_holder.ts";

const decoder = new TextDecoder();

/** Whether pid is a running process (a zombie is not). */
async function running(pid: number): Promise<boolean> {
  const { stdout } = await new Deno.Command("ps", {
    args: ["-o", "stat=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  const state = decoder.decode(stdout).trim();
  return state !== "" && !state.startsWith("Z");
}

/** Whether nothing holds the flock on lock, asked of another process. */
async function lockIsFree(lock: string): Promise<boolean> {
  const { code } = await new Deno.Command("python3", {
    args: [
      "-c",
      "import fcntl, sys\nf = open(sys.argv[1], 'a')\n" +
      "try:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\n" +
      "except BlockingIOError:\n    sys.exit(1)",
      lock,
    ],
  }).output();
  return code === 0;
}

interface Fixture {
  dir: string;
  lock: string;
  holder: string;
}

async function withCache(body: (f: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "qianfan-ocr-test-" });
  const lock = `${dir}/qianfan-ocr/model.lock`;
  await Deno.mkdir(`${dir}/qianfan-ocr`);
  try {
    await body({ dir, lock, holder: `${dir}/qianfan-ocr/holder.json` });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * A stand-in helper: a Python script named qianfan_ocr.py that takes the
 * model lock, writes holder.json naming itself, then sleeps. With
 * ignoreTerm it ignores SIGTERM.
 */
async function startHelper(f: Fixture, ignoreTerm = false) {
  const script = `${f.dir}/qianfan_ocr.py`;
  await Deno.writeTextFile(
    script,
    `import fcntl, json, os, signal, sys, time
if ${ignoreTerm ? "True" : "False"}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
lock = open(${JSON.stringify(f.lock)}, "a")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(${JSON.stringify(f.holder)}, "w") as h:
    json.dump({"pid": os.getpid(), "parentPid": os.getppid(),
               "startedAt": "2026-11-06T17:00:00Z",
               "command": "extract-batch", "batchId": "batch-b1"}, h)
print("held", flush=True)
time.sleep(60)
`,
  );
  const child = new Deno.Command("python3", {
    args: [script],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  assertEquals(decoder.decode(value).trim(), "held");
  reader.releaseLock();
  return child;
}

async function cleanUp(child: Deno.ChildProcess) {
  try {
    child.kill("SIGKILL");
  } catch { /* already gone */ }
  await child.status;
  await child.stdout.cancel().catch(() => {});
}

Deno.test("holderPath follows XDG_CACHE_HOME, else ~/.cache", () => {
  assertEquals(
    holderPath({ XDG_CACHE_HOME: "/c", HOME: "/home/u" }),
    "/c/qianfan-ocr/holder.json",
  );
  assertEquals(
    holderPath({ HOME: "/home/u" }),
    "/home/u/.cache/qianfan-ocr/holder.json",
  );
});

Deno.test("stop with no holder record reports nothing running", async () => {
  await withCache(async (f) => {
    const result = await stopHolder(f.holder);
    assertEquals(result.found, "none");
    assertEquals(result.holder, null);
    assertEquals(result.stopped, false);
  });
});

Deno.test("stop kills the helper holding the lock, and the lock is free after", async () => {
  await withCache(async (f) => {
    const helper = await startHelper(f);
    try {
      assertEquals(await lockIsFree(f.lock), false);
      const result = await stopHolder(f.holder);
      assertEquals(result.found, "running");
      assertEquals(result.holder?.pid, helper.pid);
      assertEquals(result.holder?.batchId, "batch-b1");
      assertEquals(result.stopped, true);
      assertEquals(result.signal, "SIGTERM");
      assertEquals(await running(helper.pid), false);
      assert(await lockIsFree(f.lock));
      // Its parent, this test, is not a qianfan helper and is left alone.
      assertEquals(await running(Deno.pid), true);
    } finally {
      await cleanUp(helper);
    }
  });
});

Deno.test("stop kills a helper that ignores SIGTERM after the grace period", async () => {
  await withCache(async (f) => {
    const helper = await startHelper(f, true);
    try {
      const result = await stopHolder(f.holder, { graceMs: 500 });
      assertEquals(result.stopped, true);
      assertEquals(result.signal, "SIGKILL");
      assert(await lockIsFree(f.lock));
    } finally {
      await cleanUp(helper);
    }
  });
});

Deno.test("stop leaves a stale holder record of a dead process alone", async () => {
  await withCache(async (f) => {
    const dead = new Deno.Command("true").spawn();
    await dead.status;
    const record = JSON.stringify({ pid: dead.pid, batchId: "batch-old" });
    await Deno.writeTextFile(f.holder, record);
    const result = await stopHolder(f.holder);
    assertEquals(result.found, "stale");
    assertEquals(result.holder?.batchId, "batch-old");
    assertEquals(result.stopped, false);
    // The next helper overwrites it; deleting it here could race that.
    assertEquals(await Deno.readTextFile(f.holder), record);
  });
});

Deno.test("stop never kills a reused PID that is not a qianfan helper", async () => {
  await withCache(async (f) => {
    const other = new Deno.Command("sleep", { args: ["60"] }).spawn();
    try {
      await Deno.writeTextFile(f.holder, JSON.stringify({ pid: other.pid }));
      const result = await stopHolder(f.holder);
      assertEquals(result.found, "stale");
      assertEquals(result.stopped, false);
      assertEquals(await running(other.pid), true);
    } finally {
      other.kill("SIGKILL");
      await other.status;
    }
  });
});
