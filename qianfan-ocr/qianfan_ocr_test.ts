import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import {
  type FakeUv,
  fakeUvCalls,
  makeFakeUv,
} from "./testdata/fake_uv_shim.ts";
import { behavior, DEFAULT_MODEL, DEFAULT_REVISION } from "./qianfan_ocr.ts";

type MethodName = keyof typeof behavior.methods;

const EXTRACTED = {
  model: DEFAULT_MODEL,
  revision: DEFAULT_REVISION,
  device: "mps",
  dtype: "bfloat16",
  prompt: "Read the title",
  rawOutput: '```json\n{"title": "Swamp"}\n```',
  parsed: { title: "Swamp" },
  lockWaitMs: 0,
  loadMs: 41000,
  generateMs: 9000,
};

interface Fixture {
  fake: FakeUv;
  repoDir: string;
}

async function setup(controls: Record<string, string> = {}): Promise<Fixture> {
  const fake = await makeFakeUv(controls);
  const repoDir = `${fake.dir}/repo`;
  await Deno.mkdir(`${repoDir}/scans`, { recursive: true });
  await Deno.writeFile(`${repoDir}/scans/My Scan (1).png`, new Uint8Array([1]));
  return { fake, repoDir };
}

async function call(
  f: Fixture,
  method: MethodName,
  args: Record<string, unknown>,
) {
  const test = createModelTestContext({
    globalArgs: { uvPath: f.fake.uvPath },
    methodName: method,
    repoDir: f.repoDir,
  });
  const context = {
    ...test.context,
    extensionFile: (path: string) => `/ext/qianfan-ocr/${path}`,
  };
  // deno-lint-ignore no-explicit-any
  await (behavior.methods[method].execute as any)(args, context);
  return test.getWrittenResources();
}

/** Run a method expecting it to fail; the error and what it logged. */
async function callFailing(
  f: Fixture,
  method: MethodName,
  args: Record<string, unknown>,
) {
  const test = createModelTestContext({
    globalArgs: { uvPath: f.fake.uvPath },
    methodName: method,
    repoDir: f.repoDir,
  });
  const context = {
    ...test.context,
    extensionFile: (path: string) => `/ext/qianfan-ocr/${path}`,
  };
  const error = await assertRejects(() =>
    // deno-lint-ignore no-explicit-any
    (behavior.methods[method].execute as any)(args, context)
  );
  const logs = test.getLogs().map((l) => JSON.stringify(l)).join("\n");
  return { error: error as Error, logs };
}

async function withFixture(
  controls: Record<string, string>,
  body: (f: Fixture) => Promise<void>,
) {
  const f = await setup(controls);
  try {
    await body(f);
  } finally {
    await Deno.remove(f.fake.dir, { recursive: true });
  }
}

Deno.test("extract runs the helper offline on the image and records what it read", async () => {
  await withFixture(
    { FAKE_UV_STDOUT: JSON.stringify(EXTRACTED) },
    async (f) => {
      const [written] = await call(f, "extract", {
        imagePath: "scans/My Scan (1).png",
        prompt: "Read the title",
        maxNewTokens: 256,
      });
      assertEquals(written.specName, "ocr");
      assertEquals(written.name, "ocr-My-Scan-1");
      assertEquals(written.data.parsed, { title: "Swamp" });
      assertEquals(written.data.parsedOk, true);
      assertEquals(written.data.image, `${f.repoDir}/scans/My Scan (1).png`);
      assertEquals(written.data.revision, DEFAULT_REVISION);
      assertExists(written.data.extractedAt);

      const calls = await fakeUvCalls(f.fake);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].argv, [
        "run",
        "--quiet",
        "--locked",
        "--offline",
        "--script",
        "/ext/qianfan-ocr/helper/qianfan_ocr.py",
        "extract",
        `--image=${f.repoDir}/scans/My Scan (1).png`,
        "--prompt=Read the title",
        `--model=${DEFAULT_MODEL}`,
        `--revision=${DEFAULT_REVISION}`,
        "--max-new-tokens=256",
      ]);
    },
  );
});

Deno.test("extract records parsedOk false when the output held no JSON object", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: JSON.stringify({
        ...EXTRACTED,
        rawOutput: "Swamp",
        parsed: null,
      }),
    },
    async (f) => {
      const [written] = await call(f, "extract", {
        imagePath: `${f.repoDir}/scans/My Scan (1).png`,
        prompt: "Read the title",
        name: "title-page",
      });
      assertEquals(written.name, "ocr-title-page");
      assertEquals(written.data.parsed, null);
      assertEquals(written.data.parsedOk, false);
    },
  );
});

Deno.test("extract of a missing image fails before running uv", async () => {
  await withFixture({}, async (f) => {
    const error = await assertRejects(() =>
      call(f, "extract", { imagePath: "scans/nope.png", prompt: "Read it" })
    );
    assertStringIncludes((error as Error).message, "image not found");
    assertEquals((await fakeUvCalls(f.fake)).length, 0);
  });
});

Deno.test("extract passes on the helper's run install error and logs its stderr", async () => {
  await withFixture({ FAKE_UV_RUN: "helper-error" }, async (f) => {
    const { error, logs } = await callFailing(f, "extract", {
      imagePath: "scans/My Scan (1).png",
      prompt: "Hi",
    });
    assertStringIncludes(error.message, "run install");
    assertStringIncludes(logs, "Reading");
    assertStringIncludes(logs, "qianfan-ocr helper started");
  });
});

Deno.test("an ocr result never takes the install record's name", async () => {
  await withFixture(
    { FAKE_UV_STDOUT: JSON.stringify(EXTRACTED) },
    async (f) => {
      await Deno.writeFile(`${f.repoDir}/install.png`, new Uint8Array([1]));
      const [fromStem] = await call(f, "extract", {
        imagePath: "install.png",
        prompt: "Hi",
      });
      const [fromName] = await call(f, "extract", {
        imagePath: "install.png",
        prompt: "Hi",
        name: "install",
      });
      assertEquals(fromStem.name, "ocr-install");
      assertEquals(fromName.name, "ocr-install");
    },
  );
});

Deno.test("a prompt that starts with a dash reaches the helper as the prompt", async () => {
  await withFixture(
    { FAKE_UV_STDOUT: JSON.stringify(EXTRACTED) },
    async (f) => {
      await call(f, "extract", {
        imagePath: "scans/My Scan (1).png",
        prompt: "-Transcribe",
      });
      const [run] = await fakeUvCalls(f.fake);
      assertEquals(run.argv.includes("--prompt=-Transcribe"), true);
    },
  );
});

Deno.test("install reports already installed when the environment and model were both there", async () => {
  await withFixture(
    {
      FAKE_UV_ENV: "present",
      FAKE_UV_STDOUT: JSON.stringify({
        model: DEFAULT_MODEL,
        revision: DEFAULT_REVISION,
        modelAlreadyCached: true,
        path: "/hf/snapshots/x",
      }),
    },
    async (f) => {
      const [written] = await call(f, "install", {});
      assertEquals(written.specName, "install");
      assertEquals(written.name, "install");
      assertEquals(written.data.environmentExisted, true);
      assertEquals(written.data.modelAlreadyCached, true);
      assertEquals(written.data.alreadyInstalled, true);

      const calls = await fakeUvCalls(f.fake);
      assertEquals(calls[0].argv.slice(0, 2), ["python", "find"]);
      assertEquals(calls[1].argv.includes("--offline"), false);
      assertEquals(calls[1].argv.slice(-3), [
        "install",
        `--model=${DEFAULT_MODEL}`,
        `--revision=${DEFAULT_REVISION}`,
      ]);
    },
  );
});

Deno.test("install looks for the environment before uv builds it", async () => {
  await withFixture(
    {
      FAKE_UV_ENV: "absent",
      FAKE_UV_STDOUT: JSON.stringify({
        model: DEFAULT_MODEL,
        revision: DEFAULT_REVISION,
        modelAlreadyCached: true,
        path: "/hf/snapshots/x",
      }),
    },
    async (f) => {
      const [written] = await call(f, "install", {});
      assertEquals(written.data.environmentExisted, false);
      assertEquals(written.data.alreadyInstalled, false);
    },
  );
});

Deno.test("install and extract each log when they finish", async () => {
  await withFixture(
    { FAKE_UV_STDOUT: JSON.stringify(EXTRACTED) },
    async (f) => {
      const lastLog = async (
        method: MethodName,
        args: Record<string, unknown>,
      ) => {
        const test = createModelTestContext({
          globalArgs: { uvPath: f.fake.uvPath },
          methodName: method,
          repoDir: f.repoDir,
        });
        const context = {
          ...test.context,
          extensionFile: (path: string) => `/ext/qianfan-ocr/${path}`,
        };
        // deno-lint-ignore no-explicit-any
        await (behavior.methods[method].execute as any)(args, context);
        return test.getLogs().at(-1)!;
      };
      const installed = await lastLog("install", {});
      assertStringIncludes(installed.message, "Installed");

      const wrote = await lastLog("extract", {
        imagePath: "scans/My Scan (1).png",
        prompt: "Hi",
      });
      assertStringIncludes(wrote.message, "Wrote");
      assertEquals(
        (wrote.args[0] as Record<string, unknown>).name,
        "ocr-My-Scan-1",
      );
    },
  );
});

const START = {
  type: "start",
  model: DEFAULT_MODEL,
  revision: DEFAULT_REVISION,
  device: "mps",
  dtype: "bfloat16",
  lockWaitMs: 3,
  loadMs: 14000,
};

function item(id: string, text: string) {
  return {
    type: "item",
    id,
    rawOutput: `{"text": "${text}"}`,
    parsed: { text: text },
    generateMs: 9000,
  };
}

const jsonLines = (...lines: unknown[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n");

async function batchFixture(f: Fixture) {
  for (const name of ["a", "b", "c"]) {
    await Deno.writeFile(`${f.repoDir}/scans/${name}.png`, new Uint8Array([1]));
  }
}

const ITEMS = [
  { imagePath: "scans/a.png", prompt: "Read a" },
  { imagePath: "scans/b.png", prompt: "Read b" },
  { imagePath: "scans/c.png", prompt: "Read c", name: "letter-c" },
];

/** Run a method whether it throws or not: its writes, logs and error. */
async function run(
  f: Fixture,
  method: MethodName,
  args: Record<string, unknown>,
) {
  const test = createModelTestContext({
    globalArgs: { uvPath: f.fake.uvPath },
    methodName: method,
    repoDir: f.repoDir,
  });
  const context = {
    ...test.context,
    extensionFile: (path: string) => `/ext/qianfan-ocr/${path}`,
  };
  let error: Error | null = null;
  try {
    // deno-lint-ignore no-explicit-any
    await (behavior.methods[method].execute as any)(args, context);
  } catch (e) {
    error = e as Error;
  }
  return { written: test.getWrittenResources(), logs: test.getLogs(), error };
}

function batchRecord(
  written: { specName: string; name: string; data: unknown }[],
) {
  const batches = written.filter((w) => w.specName === "batch");
  assertEquals(batches.length, 1);
  // deno-lint-ignore no-explicit-any
  return batches[0] as { name: string; data: any };
}

Deno.test("extractBatch writes an ocr record per item and a batch record, with one helper run", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        item("0", "a"),
        item("1", "b"),
        item("2", "c"),
        { type: "end", count: 3 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
        maxNewTokens: 64,
        name: "post",
      });
      assertEquals(error, null);
      const ocr = written.filter((w) => w.specName === "ocr");
      assertEquals(ocr.map((w) => w.name), [
        "ocr-a",
        "ocr-b",
        "ocr-letter-c",
      ]);
      assertEquals(ocr[1].data.parsed, { text: "b" });
      assertEquals(ocr[1].data.prompt, "Read b");
      assertEquals(ocr[1].data.image, `${f.repoDir}/scans/b.png`);
      assertEquals(ocr[1].data.loadMs, 14000);

      const batch = batchRecord(written);
      assertEquals(batch.name, "batch-post");
      assertEquals(batch.data.succeeded, 3);
      assertEquals(
        batch.data.items.map((i: { record: string }) => i.record),
        ["ocr-a", "ocr-b", "ocr-letter-c"],
      );

      const calls = await fakeUvCalls(f.fake);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].requests, [
        {
          id: "0",
          image: `${f.repoDir}/scans/a.png`,
          prompt: "Read a",
          maxNewTokens: 64,
        },
        {
          id: "1",
          image: `${f.repoDir}/scans/b.png`,
          prompt: "Read b",
          maxNewTokens: 64,
        },
        {
          id: "2",
          image: `${f.repoDir}/scans/c.png`,
          prompt: "Read c",
          maxNewTokens: 64,
        },
      ]);
    },
  );
});

Deno.test("extractBatch passes model and revision to the helper", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        { ...START, model: "me/ocr", revision: "f00" },
        item("0", "a"),
        { type: "end", count: 1 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { written } = await run(f, "extractBatch", {
        items: [ITEMS[0]],
        model: "me/ocr",
        revision: "f00",
      });
      const [call] = await fakeUvCalls(f.fake);
      assertEquals(call.argv.includes("--offline"), true);
      assertEquals(call.argv.at(-4), "extract-batch");
      assertEquals(call.argv.slice(-2), ["--model=me/ocr", "--revision=f00"]);
      assertEquals(batchRecord(written).data.revision, "f00");
    },
  );
});

Deno.test("extractBatch records a missing image as that item's error and reads the rest", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        item("0", "a"),
        item("2", "c"),
        { type: "end", count: 2 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      await Deno.remove(`${f.repoDir}/scans/b.png`);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
      });
      assertEquals(error, null);
      const [call] = await fakeUvCalls(f.fake);
      assertEquals(
        (call.requests as { id: string }[]).map((r) => r.id),
        ["0", "2"],
      );
      const batch = batchRecord(written).data;
      assertEquals(batch.items[1].status, "error");
      assertStringIncludes(batch.items[1].error, "image not found");
      assertEquals(batch.items[1].record, null);
      assertEquals(
        written.filter((w) => w.specName === "ocr").map((w) => w.name),
        ["ocr-a", "ocr-letter-c"],
      );
    },
  );
});

Deno.test("extractBatch names an ocr record on the batch only for items that succeeded", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        item("0", "a"),
        { type: "item", id: "1", error: "RuntimeError: MPS out of memory" },
        item("2", "c"),
        { type: "end", count: 3 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
      });
      assertEquals(error, null);
      const batch = batchRecord(written).data;
      assertEquals(batch.items.map((i: { status: string }) => i.status), [
        "ok",
        "error",
        "ok",
      ]);
      assertEquals(batch.items[1].record, null);
      assertEquals(batch.items[1].error, "RuntimeError: MPS out of memory");
      assertEquals(
        written.some((w) => w.name === "ocr-b"),
        false,
      );
      assertEquals([batch.succeeded, batch.failed, batch.notRun], [2, 1, 0]);
    },
  );
});

Deno.test("extractBatch keeps the finished items when the helper dies part way, then fails", async () => {
  await withFixture(
    {
      FAKE_UV_RUN: "lines-then-crash",
      FAKE_UV_STDOUT: jsonLines(START, item("0", "a"), item("1", "b")),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
      });
      assertExists(error);
      assertStringIncludes(error.message, "exit 137");
      assertEquals(
        written.filter((w) => w.specName === "ocr").map((w) => w.name),
        ["ocr-a", "ocr-b"],
      );
      const batch = batchRecord(written).data;
      assertEquals(batch.items[2].status, "notRun");
      assertStringIncludes(batch.error, "exit 137");
    },
  );
});

Deno.test("extractBatch fails when the helper exits 0 but leaves an item out", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        item("0", "a"),
        item("2", "c"),
        { type: "end", count: 3 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
      });
      assertExists(error);
      assertStringIncludes(error.message, "left out 1 item");
      const batch = batchRecord(written).data;
      assertEquals(batch.items[1].status, "notRun");
      assertEquals(batch.items[0].record, "ocr-a");
    },
  );
});

Deno.test("extractBatch fails when the helper exits 0 without its end line", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(START, item("0", "a")),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: [ITEMS[0]],
      });
      assertExists(error);
      assertStringIncludes(error.message, "end");
      assertEquals(batchRecord(written).data.succeeded, 1);
    },
  );
});

Deno.test("extractBatch with two items taking one record name fails before running the helper", async () => {
  await withFixture({}, async (f) => {
    await batchFixture(f);
    const { written, error } = await run(f, "extractBatch", {
      items: [ITEMS[0], { imagePath: "scans/b.png", prompt: "p", name: "a" }],
    });
    assertExists(error);
    assertStringIncludes(error.message, "ocr-a");
    assertEquals(written, []);
    assertEquals((await fakeUvCalls(f.fake)).length, 0);
  });
});

Deno.test("extractBatch writes nothing when the helper fails before any item", async () => {
  await withFixture({ FAKE_UV_RUN: "helper-error" }, async (f) => {
    await batchFixture(f);
    const { written, error } = await run(f, "extractBatch", {
      items: ITEMS,
    });
    assertExists(error);
    assertStringIncludes(error.message, "run install");
    assertEquals(written, []);
  });
});

Deno.test("extractBatch removes its requests file afterwards", async () => {
  await withFixture({ FAKE_UV_RUN: "helper-error" }, async (f) => {
    await batchFixture(f);
    await run(f, "extractBatch", { items: ITEMS });
    const [call] = await fakeUvCalls(f.fake);
    const requests = call.argv.find((a) => a.startsWith("--requests="))!
      .slice("--requests=".length);
    await assertRejects(() => Deno.stat(requests), Deno.errors.NotFound);
  });
});

Deno.test("extractBatch names its batch record after the time by default", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(START, item("0", "a"), {
        type: "end",
        count: 1,
      }),
    },
    async (f) => {
      await batchFixture(f);
      const { written } = await run(f, "extractBatch", { items: [ITEMS[0]] });
      assertMatch(
        batchRecord(written).name,
        /^batch-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
      );
    },
  );
});

Deno.test("extractBatch warns when no item succeeded", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        { type: "item", id: "0", error: "RuntimeError: boom" },
        { type: "end", count: 1 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { logs, error } = await run(f, "extractBatch", {
        items: [ITEMS[0]],
      });
      assertEquals(error, null);
      const warning = logs.find((l) => l.level === "warning");
      assertExists(warning);
      assertStringIncludes(warning.message, "No item");
    },
  );
});

Deno.test("extractBatch with every image missing writes only the batch record", async () => {
  await withFixture({}, async (f) => {
    const { written, error, logs } = await run(f, "extractBatch", {
      items: [{ imagePath: "scans/nope.png", prompt: "p" }],
    });
    assertEquals(error, null);
    assertEquals(written.map((w) => w.specName), ["batch"]);
    assertEquals((await fakeUvCalls(f.fake)).length, 0);
    assertExists(logs.find((l) => l.level === "warning"));
  });
});

Deno.test("extractBatch records a malformed item line as that item's error and still writes the batch", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(
        START,
        item("0", "a"),
        { type: "item", id: "1", parsed: null },
        item("2", "c"),
        { type: "end", count: 3 },
      ),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: ITEMS,
      });
      assertEquals(error, null);
      assertEquals(
        written.filter((w) => w.specName === "ocr").map((w) => w.name),
        ["ocr-a", "ocr-letter-c"],
      );
      const batch = batchRecord(written).data;
      assertEquals(batch.items[1].status, "error");
      assertStringIncludes(batch.items[1].error, "malformed");
      assertEquals(batch.items[1].record, null);
    },
  );
});

Deno.test("extractBatch records items as errors when the helper printed no start line", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(item("0", "a"), { type: "end", count: 1 }),
    },
    async (f) => {
      await batchFixture(f);
      const { written, error } = await run(f, "extractBatch", {
        items: [ITEMS[0]],
      });
      assertEquals(error, null);
      assertEquals(written.map((w) => w.specName), ["batch"]);
      assertStringIncludes(
        batchRecord(written).data.items[0].error,
        "malformed",
      );
    },
  );
});

Deno.test("extractBatch still writes its records when removing its temp dir fails", async () => {
  await withFixture(
    {
      FAKE_UV_STDOUT: jsonLines(START, item("0", "a"), {
        type: "end",
        count: 1,
      }),
    },
    async (f) => {
      await batchFixture(f);
      const remove = Deno.remove;
      const kept: string[] = [];
      Deno.remove = (path, options) => {
        if (!String(path).includes("qianfan-ocr-")) {
          return remove(path, options);
        }
        kept.push(String(path));
        return Promise.reject(new Error("resource busy"));
      };
      try {
        const { written, error, logs } = await run(f, "extractBatch", {
          items: [ITEMS[0]],
        });
        assertEquals(error, null);
        assertEquals(written.map((w) => w.specName), ["ocr", "batch"]);
        const warning = logs.find((l) => l.level === "warning");
        assertExists(warning);
        assertStringIncludes(warning.message, "temp");
      } finally {
        Deno.remove = remove;
        for (const path of kept) await remove(path, { recursive: true });
      }
    },
  );
});
