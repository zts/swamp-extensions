// A stand-in for uv, for the behavior's tests. It answers the two commands
// the behavior runs, `uv python find --script <script>` and
// `uv run ... --script <script> <args>`, and never touches the network.
//
// Controls, read from the environment the test's shim sets:
//   FAKE_UV_CALLS   file to append each invocation to, as a JSON line of
//                   {argv, HF_HOME, HF_HUB_OFFLINE,
//                   HF_HUB_DISABLE_PROGRESS_BARS, requests}, where requests
//                   is the first line of stdin, parsed, for extract-batch
//   FAKE_UV_ENV     "present" (default) | "absent": what python find prints
//   FAKE_UV_RUN     "ok" (default) | "uv-fail" | "helper-error" | "crash" |
//                   "garbage" | "hang" | "lines-then-crash" | "torn" |
//                   "hold" | "orphan" | "progress": how run behaves.
//                   "progress" draws a tqdm-style bar redrawn with \r, whose
//                   closing \r and \n go out as two writes. "hold" waits for
//                   stdin to close; "orphan" exits at once, leaving a child
//                   that holds stdout open until stdin closes, as a Python
//                   that outlived uv would. Both write FAKE_UV_PIDFILE (the
//                   waiting process's pid) and, once stdin closed,
//                   FAKE_UV_PIDFILE.eof
//   FAKE_UV_STDOUT  what run prints on "ok", "lines-then-crash" and "torn"
//                   (one JSON object, or JSON lines); "lines-then-crash"
//                   then dies, and "torn" then dies mid-line
const STARTED = "qianfan-ocr helper started";

const args = Deno.args;
const env = (name: string) => Deno.env.get(name);

/** The first line of stdin, without reading past it. */
async function readLine(): Promise<string> {
  const bytes: number[] = [];
  const one = new Uint8Array(1);
  while (await Deno.stdin.read(one) === 1 && one[0] !== 10) bytes.push(one[0]);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const requestsLine = args.includes("extract-batch") ? await readLine() : null;
const calls = env("FAKE_UV_CALLS");
if (calls) {
  await Deno.writeTextFile(
    calls,
    JSON.stringify({
      argv: args,
      HF_HOME: env("HF_HOME") ?? null,
      HF_HUB_OFFLINE: env("HF_HUB_OFFLINE") ?? null,
      HF_HUB_DISABLE_PROGRESS_BARS: env("HF_HUB_DISABLE_PROGRESS_BARS") ?? null,
      requests: requestsLine ? JSON.parse(requestsLine) : null,
    }) + "\n",
    { append: true },
  );
}

const out = (text: string) =>
  Deno.stdout.writeSync(new TextEncoder().encode(text));
const err = (text: string) =>
  Deno.stderr.writeSync(new TextEncoder().encode(text));

if (args[0] === "python" && args[1] === "find") {
  if ((env("FAKE_UV_ENV") ?? "present") === "present") {
    out("/home/u/.cache/uv/environments-v2/qianfan_ocr-0123abcd/bin/python\n");
  } else {
    out("/home/u/.local/share/uv/python/cpython-3.13/bin/python3.13\n");
  }
  Deno.exit(0);
}

if (args[0] !== "run") {
  err(`fake uv: unexpected command ${JSON.stringify(args)}\n`);
  Deno.exit(2);
}

switch (env("FAKE_UV_RUN") ?? "ok") {
  case "ok":
    err(`${STARTED}\nloading model\n`);
    out(`${env("FAKE_UV_STDOUT") ?? "{}"}\n`);
    Deno.exit(0);
    break;
  case "progress":
    err(`${STARTED}\n`);
    err("Loading weights:   0%|          | 0/745 [00:00<?, ?it/s]\r");
    err("Loading weights: 100%|##########| 745/745 [00:02<00:00]\r");
    // The bar's last \r and the \n that ends it reach the reader apart.
    await new Promise((resolve) => setTimeout(resolve, 200));
    err("\n");
    err("model loaded\n");
    out("{}\n");
    Deno.exit(0);
    break;
  case "uv-fail":
    err(
      "error: Failed to download `torch==2.16.0`\n  cause: Network connectivity is disabled\n",
    );
    Deno.exit(1);
    break;
  case "helper-error":
    err(`${STARTED}\n`);
    out(
      `{"error": "model x@y is not in the Hugging Face cache; run install"}\n`,
    );
    Deno.exit(1);
    break;
  case "crash":
    err(`${STARTED}\nloading model\nKilled: 9\n`);
    Deno.exit(137);
    break;
  case "garbage":
    err(`${STARTED}\n`);
    out("this is not json\n");
    Deno.exit(0);
    break;
  case "lines-then-crash":
    err(`${STARTED}\nloading model\n`);
    out(`${env("FAKE_UV_STDOUT") ?? ""}\n`);
    err("Killed: 9\n");
    Deno.exit(137);
    break;
  case "torn":
    err(`${STARTED}\n`);
    out(`${env("FAKE_UV_STDOUT") ?? ""}\n{"type": "item", "id": "to`);
    Deno.exit(137);
    break;
  case "hang":
    err(`${STARTED}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    Deno.exit(0);
    break;
  case "hold": {
    err(`${STARTED}\n`);
    const pidFile = env("FAKE_UV_PIDFILE")!;
    await Deno.writeTextFile(pidFile, String(Deno.pid));
    // Give up after a while, so a broken test leaves nothing running.
    setTimeout(() => Deno.exit(3), 30_000);
    const buffer = new Uint8Array(4096);
    while (await Deno.stdin.read(buffer) !== null) { /* until EOF */ }
    await Deno.writeTextFile(`${pidFile}.eof`, "eof");
    Deno.exit(1);
    break;
  }
  case "orphan": {
    err(`${STARTED}\n`);
    const pidFile = env("FAKE_UV_PIDFILE")!;
    // sh inherits stdin, stdout and stderr, and outlives this process.
    const child = new Deno.Command("sh", {
      args: [
        "-c",
        `echo $$ > '${pidFile}'; cat > /dev/null; echo eof > '${pidFile}.eof'`,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    child.unref();
    while (!await Deno.stat(pidFile).then(() => true, () => false)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    Deno.exit(1);
  }
}
