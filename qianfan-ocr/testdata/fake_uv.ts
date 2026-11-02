// A stand-in for uv, for the behavior's tests. It answers the two commands
// the behavior runs, `uv python find --script <script>` and
// `uv run ... --script <script> <args>`, and never touches the network.
//
// Controls, read from the environment the test's shim sets:
//   FAKE_UV_CALLS   file to append each invocation to, as a JSON line of
//                   {argv, HF_HOME, HF_HUB_OFFLINE, requests}, where requests
//                   is the parsed --requests file, read while it still exists
//   FAKE_UV_ENV     "present" (default) | "absent": what python find prints
//   FAKE_UV_RUN     "ok" (default) | "uv-fail" | "helper-error" | "crash" |
//                   "garbage" | "hang" | "lines-then-crash" | "torn": how
//                   run behaves
//   FAKE_UV_STDOUT  what run prints on "ok", "lines-then-crash" and "torn"
//                   (one JSON object, or JSON lines); "lines-then-crash"
//                   then dies, and "torn" then dies mid-line
const STARTED = "qianfan-ocr helper started";

const args = Deno.args;
const env = (name: string) => Deno.env.get(name);

const requestsArg = args.find((a) => a.startsWith("--requests="));
const calls = env("FAKE_UV_CALLS");
if (calls) {
  await Deno.writeTextFile(
    calls,
    JSON.stringify({
      argv: args,
      HF_HOME: env("HF_HOME") ?? null,
      HF_HUB_OFFLINE: env("HF_HUB_OFFLINE") ?? null,
      requests: requestsArg
        ? JSON.parse(
          await Deno.readTextFile(requestsArg.slice("--requests=".length)),
        )
        : null,
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
}
