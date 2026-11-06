import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { fakeUvCalls, makeFakeUv } from "./testdata/fake_uv_shim.ts";
import {
  environmentExists,
  runHelper,
  runHelperLines,
  STARTED,
} from "./uv_runner.ts";

const SCRIPT = "/ext/helper/qianfan_ocr.py";

async function withFakeUv(
  controls: Record<string, string>,
  body: (fake: Awaited<ReturnType<typeof makeFakeUv>>) => Promise<void>,
) {
  const fake = await makeFakeUv(controls);
  try {
    await body(fake);
  } finally {
    await Deno.remove(fake.dir, { recursive: true });
  }
}

function settings(uvPath: string, hfHome?: string) {
  return { uvPath, hfHome, signal: new AbortController().signal };
}

Deno.test("environmentExists is true when uv finds the script's own environment", async () => {
  await withFakeUv({ FAKE_UV_ENV: "present" }, async (fake) => {
    assert(await environmentExists(settings(fake.uvPath), SCRIPT));
    const [call] = await fakeUvCalls(fake);
    assertEquals(call.argv, ["python", "find", "--script", SCRIPT]);
  });
});

Deno.test("environmentExists is false when uv only finds an interpreter outside environments-v2", async () => {
  await withFakeUv({ FAKE_UV_ENV: "absent" }, async (fake) => {
    assertEquals(await environmentExists(settings(fake.uvPath), SCRIPT), false);
  });
});

Deno.test("runHelper returns the helper's JSON and hands on its stderr", async () => {
  await withFakeUv({ FAKE_UV_STDOUT: '{"rawOutput": "hi"}' }, async (fake) => {
    const seen: string[] = [];
    const result = await runHelper(
      settings(fake.uvPath),
      SCRIPT,
      ["extract", "--image=a.png"],
      { offline: true, onStderr: (text) => seen.push(text) },
    );
    assertEquals(result, { rawOutput: "hi" });
    assertStringIncludes(seen.join(""), "loading model");
  });
});

Deno.test("runHelper hands on each stderr line while the helper is still running", async () => {
  await withFakeUv({ FAKE_UV_RUN: "hang" }, async (fake) => {
    const controller = new AbortController();
    // Stops the hang if no line arrives before it ends.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 5_000);
    const seen: string[] = [];
    try {
      await assertRejects(() =>
        runHelper(
          { uvPath: fake.uvPath, signal: controller.signal },
          SCRIPT,
          ["extract"],
          {
            offline: true,
            onStderr: (line) => {
              seen.push(line);
              controller.abort();
            },
          },
        )
      );
    } finally {
      clearTimeout(timer);
    }
    assertEquals(seen, [STARTED]);
    assertEquals(timedOut, false);
  });
});

Deno.test("runHelper hands on the helper's stderr when the helper fails", async () => {
  await withFakeUv({ FAKE_UV_RUN: "helper-error" }, async (fake) => {
    const seen: string[] = [];
    await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["extract"], {
        offline: true,
        onStderr: (text) => seen.push(text),
      })
    );
    assertStringIncludes(seen.join(""), "qianfan-ocr helper started");
  });
});

Deno.test("runHelper runs the locked script, offline and with HF_HUB_OFFLINE when asked", async () => {
  await withFakeUv({}, async (fake) => {
    await runHelper(settings(fake.uvPath), SCRIPT, ["extract"], {
      offline: true,
    });
    const [call] = await fakeUvCalls(fake);
    assertEquals(call.argv, [
      "run",
      "--quiet",
      "--locked",
      "--offline",
      "--script",
      SCRIPT,
      "--watch-stdin",
      "extract",
    ]);
    assertEquals(call.HF_HUB_OFFLINE, "1");
  });
});

Deno.test("runHelper may reach the network when not offline", async () => {
  await withFakeUv({}, async (fake) => {
    await runHelper(settings(fake.uvPath), SCRIPT, ["install"], {
      offline: false,
    });
    const [call] = await fakeUvCalls(fake);
    assertEquals(call.argv.includes("--offline"), false);
    assertEquals(call.HF_HUB_OFFLINE, null);
  });
});

Deno.test("runHelper passes hfHome as HF_HOME, and leaves it alone when unset", async () => {
  await withFakeUv({}, async (fake) => {
    await runHelper(settings(fake.uvPath, "/models/hf"), SCRIPT, ["install"], {
      offline: false,
    });
    await runHelper(settings(fake.uvPath), SCRIPT, ["install"], {
      offline: false,
    });
    const [withHome, without] = await fakeUvCalls(fake);
    assertEquals(withHome.HF_HOME, "/models/hf");
    assertEquals(without.HF_HOME, Deno.env.get("HF_HOME") ?? null);
  });
});

Deno.test("a missing uv is reported as uv: not found", async () => {
  const error = await assertRejects(() =>
    runHelper(settings("/nonexistent/uv"), SCRIPT, ["install"], {
      offline: false,
    })
  );
  assertStringIncludes((error as Error).message, "uv: not found");
});

Deno.test("uv failing before the helper starts says run install when offline", async () => {
  await withFakeUv({ FAKE_UV_RUN: "uv-fail" }, async (fake) => {
    const error = await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["extract"], { offline: true })
    );
    const message = (error as Error).message;
    assertStringIncludes(
      message,
      "Python environment is missing or out of date; run install",
    );
    assertStringIncludes(message, "Network connectivity is disabled");
  });
});

Deno.test("uv failing during install reports uv's error without advising install", async () => {
  await withFakeUv({ FAKE_UV_RUN: "uv-fail" }, async (fake) => {
    const error = await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["install"], { offline: false })
    );
    const message = (error as Error).message;
    assertStringIncludes(message, "uv could not run the helper");
    assertEquals(message.includes("run install"), false);
  });
});

Deno.test("the helper's own JSON error is passed through as is", async () => {
  await withFakeUv({ FAKE_UV_RUN: "helper-error" }, async (fake) => {
    const error = await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["extract"], { offline: true })
    );
    assertEquals(
      (error as Error).message,
      "model x@y is not in the Hugging Face cache; run install",
    );
  });
});

Deno.test("a helper that dies after starting is not blamed on a missing install", async () => {
  await withFakeUv({ FAKE_UV_RUN: "crash" }, async (fake) => {
    const error = await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["extract"], { offline: true })
    );
    const message = (error as Error).message;
    assertStringIncludes(message, "qianfan_ocr.py extract failed (exit 137)");
    assertStringIncludes(message, "Killed: 9");
    assertEquals(message.includes("run install"), false);
  });
});

Deno.test("output that is not one JSON object is an error", async () => {
  await withFakeUv({ FAKE_UV_RUN: "garbage" }, async (fake) => {
    const error = await assertRejects(() =>
      runHelper(settings(fake.uvPath), SCRIPT, ["extract"], { offline: true })
    );
    assertStringIncludes((error as Error).message, "this is not json");
  });
});

Deno.test("aborting the signal stops the helper", async () => {
  await withFakeUv({ FAKE_UV_RUN: "hang" }, async (fake) => {
    const controller = new AbortController();
    const started = Date.now();
    const run = runHelper(
      { uvPath: fake.uvPath, signal: controller.signal },
      SCRIPT,
      ["extract"],
      { offline: true },
    );
    setTimeout(() => controller.abort(), 500);
    await assertRejects(() => run);
    assert(Date.now() - started < 30_000);
  });
});

const REQUESTS = '[{"id": "0"}]\n';

const LINES = [
  '{"type": "start", "loadMs": 5}',
  '{"type": "item", "id": "0", "rawOutput": "a"}',
  '{"type": "item", "id": "1", "error": "image not found: b.png"}',
].join("\n");

Deno.test("runHelperLines returns every line of a run that succeeds", async () => {
  await withFakeUv(
    { FAKE_UV_STDOUT: `${LINES}\n{"type": "end", "count": 2}` },
    async (fake) => {
      const run = await runHelperLines(
        settings(fake.uvPath),
        SCRIPT,
        ["extract-batch"],
        { offline: true, stdin: REQUESTS },
      );
      assertEquals(run.ok, true);
      assertEquals(run.error, null);
      assertEquals(run.lines.map((l) => l.type), [
        "start",
        "item",
        "item",
        "end",
      ]);
    },
  );
});

Deno.test("runHelperLines keeps the lines written before the helper died", async () => {
  await withFakeUv(
    { FAKE_UV_RUN: "lines-then-crash", FAKE_UV_STDOUT: LINES },
    async (fake) => {
      const seen: string[] = [];
      const run = await runHelperLines(
        settings(fake.uvPath),
        SCRIPT,
        ["extract-batch"],
        { offline: true, stdin: REQUESTS, onStderr: (text) => seen.push(text) },
      );
      assertEquals(run.ok, false);
      assertEquals(run.lines.length, 3);
      assertEquals(run.lines[1].rawOutput, "a");
      assertStringIncludes(
        run.error!,
        "qianfan_ocr.py extract-batch failed (exit 137)",
      );
      assertStringIncludes(run.error!, "Killed: 9");
      assertStringIncludes(seen.join(""), "Killed: 9");
    },
  );
});

Deno.test("runHelperLines drops a line the helper died part way through", async () => {
  await withFakeUv(
    { FAKE_UV_RUN: "torn", FAKE_UV_STDOUT: LINES },
    async (fake) => {
      const run = await runHelperLines(
        settings(fake.uvPath),
        SCRIPT,
        ["extract-batch"],
        { offline: true, stdin: REQUESTS },
      );
      assertEquals(run.ok, false);
      assertEquals(run.lines.map((l) => l.id ?? l.type), ["start", "0", "1"]);
    },
  );
});

Deno.test("runHelperLines reports the helper's JSON error before its first line", async () => {
  await withFakeUv({ FAKE_UV_RUN: "helper-error" }, async (fake) => {
    const run = await runHelperLines(
      settings(fake.uvPath),
      SCRIPT,
      ["extract-batch"],
      { offline: true, stdin: REQUESTS },
    );
    assertEquals(run.ok, false);
    assertEquals(run.lines, []);
    assertEquals(
      run.error,
      "model x@y is not in the Hugging Face cache; run install",
    );
  });
});

Deno.test("runHelperLines tells uv failing before the helper started apart", async () => {
  await withFakeUv({ FAKE_UV_RUN: "uv-fail" }, async (fake) => {
    const run = await runHelperLines(
      settings(fake.uvPath),
      SCRIPT,
      ["extract-batch"],
      { offline: true, stdin: REQUESTS },
    );
    assertEquals(run.ok, false);
    assertStringIncludes(
      run.error!,
      "Python environment is missing or out of date; run install",
    );
  });
});

/** Poll until condition holds or seconds pass; whether it held. */
async function waitFor(condition: () => Promise<boolean>, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await condition();
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

Deno.test("the helper gets the stdin payload, and stdin stays open until the run ends", async () => {
  await withFakeUv({ FAKE_UV_RUN: "hold" }, async (fake) => {
    const pidFile = `${fake.dir}/helper.pid`;
    Deno.env.set("FAKE_UV_PIDFILE", pidFile);
    const controller = new AbortController();
    try {
      const run = runHelperLines(
        { uvPath: fake.uvPath, signal: controller.signal },
        SCRIPT,
        ["extract-batch"],
        { offline: true, stdin: '[{"id": "0"}]\n' },
      );
      assert(
        await waitFor(() => exists(pidFile), 20),
        "the fake never started",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals(await exists(`${pidFile}.eof`), false, "stdin closed early");
      const [call] = await fakeUvCalls(fake);
      assertEquals(call.requests, [{ id: "0" }]);
      controller.abort();
      await run.catch(() => {});
    } finally {
      Deno.env.delete("FAKE_UV_PIDFILE");
    }
  });
});

Deno.test("a large stdin payload to a uv that fails early reports uv's error", async () => {
  await withFakeUv({ FAKE_UV_RUN: "uv-fail" }, async (fake) => {
    const run = await runHelperLines(
      settings(fake.uvPath),
      SCRIPT,
      ["extract-batch"],
      { offline: true, stdin: `${"x".repeat(1 << 20)}\n` },
    );
    assertEquals(run.ok, false);
    assertStringIncludes(
      run.error!,
      "Python environment is missing or out of date; run install",
    );
  });
});

Deno.test("stdin closes when uv exits, so a helper that outlived it stops too", async () => {
  await withFakeUv({ FAKE_UV_RUN: "orphan" }, async (fake) => {
    const pidFile = `${fake.dir}/helper.pid`;
    Deno.env.set("FAKE_UV_PIDFILE", pidFile);
    try {
      const started = Date.now();
      const run = await runHelperLines(
        settings(fake.uvPath),
        SCRIPT,
        ["extract"],
        { offline: true },
      );
      assertEquals(run.ok, false);
      assert(Date.now() - started < 20_000);
      assert(await waitFor(() => exists(`${pidFile}.eof`), 5));
    } finally {
      Deno.env.delete("FAKE_UV_PIDFILE");
    }
  });
});
