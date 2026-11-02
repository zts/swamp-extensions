import {
  assertEquals,
  assertExists,
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
