import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { withMockedCommand } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import {
  checkVersion,
  dnsCredentials,
  hasDnsCredential,
  legoVersion,
  parseDnsHelpCredentials,
  runLego,
} from "./lego_runner.ts";

const MYTHICBEASTS_HELP = `Configuration for MythicBeasts.
Code:   'mythicbeasts'
Since:  'v0.3.7'

Credentials:
  - "MYTHICBEASTS_PASSWORD":  Password
  - "MYTHICBEASTS_USERNAME":  User name

Additional Configuration:
  - "MYTHICBEASTS_API_ENDPOINT":         The endpoint for the API (must implement v2)
  - "MYTHICBEASTS_TTL":                  The TTL of the TXT record used for the DNS challenge in seconds (Default: 120)

More information: https://go-acme.github.io/lego/dns/mythicbeasts
`;

const CLOUDFLARE_HELP = `Configuration for Cloudflare.
Code:   'cloudflare'

Credentials:
  - "CF_API_EMAIL":               Account email
  - "CF_API_KEY":                 API key
  - "CF_DNS_API_TOKEN":           API token with DNS:Edit permission (since v3.1.0)
  - "CF_ZONE_API_TOKEN":          API token with Zone:Read permission (since v3.1.0)
  - "CLOUDFLARE_API_KEY":         Alias to CF_API_KEY
  - "CLOUDFLARE_DNS_API_TOKEN":   Alias to CF_DNS_API_TOKEN
  - "CLOUDFLARE_EMAIL":           Alias to CF_API_EMAIL
  - "CLOUDFLARE_ZONE_API_TOKEN":  Alias to CF_ZONE_API_TOKEN

Additional Configuration:
  - "CLOUDFLARE_TTL":  The TTL of the TXT record
`;

const ROUTE53_HELP = `Credentials:
  - "AWS_ACCESS_KEY_ID":                 Managed by the AWS client. Access key ID
  - "AWS_PROFILE":                       Managed by the AWS client ('AWS_PROFILE_FILE' is not supported)
  - "AWS_REGION":                        Managed by the AWS client
  - "AWS_SECRET_ACCESS_KEY":             Managed by the AWS client. Secret access key

Additional Configuration:
  - "AWS_MAX_RETRIES":  The number of maximum returns the service will use to make an individual API request
`;

Deno.test("checkVersion accepts lego 5 and refuses anything else", () => {
  assertEquals(checkVersion("lego version 5.6.0 darwin/arm64\n"), "5.6.0");
  assertEquals(checkVersion("lego version 5.0.1 linux/amd64"), "5.0.1");
  assertThrows(
    () => checkVersion("lego version 4.21.0 linux/amd64"),
    Error,
    "needs lego 5",
  );
  assertThrows(() => checkVersion("garbage"), Error, "garbage");
});

Deno.test("legoVersion runs <binary> --version", async () => {
  const { result, calls } = await withMockedCommand(
    [{ stdout: "lego version 5.6.0 darwin/arm64\n", code: 0 }],
    () => legoVersion("/opt/bin/lego"),
  );
  assertEquals(result, "5.6.0");
  assertEquals(calls[0].command, "/opt/bin/lego");
  assertEquals(calls[0].args, ["--version"]);
});

Deno.test("legoVersion explains a missing binary", async () => {
  const missing = `/nonexistent/lego-${crypto.randomUUID()}`;
  await assertRejects(() => legoVersion(missing), Error, "legoPath");
});

Deno.test("parseDnsHelpCredentials lists only the Credentials section", () => {
  assertEquals(parseDnsHelpCredentials(MYTHICBEASTS_HELP), [
    "MYTHICBEASTS_PASSWORD",
    "MYTHICBEASTS_USERNAME",
  ]);
  assertEquals(parseDnsHelpCredentials(CLOUDFLARE_HELP).length, 8);
  assertEquals(parseDnsHelpCredentials(ROUTE53_HELP), [
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  assertEquals(parseDnsHelpCredentials("no such section"), []);
});

Deno.test("dnsCredentials runs dnshelp for the provider", async () => {
  const { result, calls } = await withMockedCommand(
    [{ stdout: MYTHICBEASTS_HELP, code: 0 }],
    () => dnsCredentials("lego", "mythicbeasts"),
  );
  assertEquals(result.length, 2);
  assertEquals(calls[0].args, ["dnshelp", "-c", "mythicbeasts"]);
});

Deno.test("dnsCredentials reports an unknown provider", async () => {
  await withMockedCommand(
    [{ stdout: "", stderr: "unsupported DNS provider: nope", code: 1 }],
    async () => {
      await assertRejects(
        () => dnsCredentials("lego", "nope"),
        Error,
        "unsupported DNS provider: nope",
      );
    },
  );
});

Deno.test("hasDnsCredential needs any one listed variable, or its _FILE form", () => {
  const cf = parseDnsHelpCredentials(CLOUDFLARE_HELP);
  assert(hasDnsCredential(cf, { CF_DNS_API_TOKEN: "t" }));
  assert(hasDnsCredential(cf, { CLOUDFLARE_DNS_API_TOKEN_FILE: "/run/t" }));
  assert(!hasDnsCredential(cf, { CLOUDFLARE_TTL: "120" }));
  assert(!hasDnsCredential(cf, { CF_DNS_API_TOKEN: "" }));
  // A provider that lists no credentials needs none.
  assert(hasDnsCredential([], {}));
});

async function script(body: string): Promise<{ path: string; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "lego-runner-test-" });
  const path = `${dir}/fake-lego`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { path, dir };
}

Deno.test("runLego passes argv and exactly the given env, with stdin closed", async () => {
  const { path, dir } = await script(
    'echo "args:$*"; echo "token:$TOKEN"; echo "home:${HOME:-unset}"; ' +
      'read line && echo "stdin:$line" || echo "stdin:closed"; ' +
      "echo oops >&2; exit 3",
  );
  try {
    const result = await runLego(path, ["run", "-d", "a b"], { TOKEN: "t1" }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    assertEquals(result.code, 3);
    assertEquals(result.timedOut, false);
    assertStringIncludes(result.stdout, "args:run -d a b");
    assertStringIncludes(result.stdout, "token:t1");
    assertStringIncludes(result.stdout, "home:unset");
    assertStringIncludes(result.stdout, "stdin:closed");
    assertEquals(result.stderr, "oops\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runLego stops lego with SIGTERM at the timeout", async () => {
  const { path, dir } = await script(
    "trap 'echo got-term; exit 143' TERM; while :; do sleep 0.05; done",
  );
  try {
    const result = await runLego(path, [], {}, {
      signal: new AbortController().signal,
      timeoutMs: 300,
      killGraceMs: 5_000,
    });
    assertEquals(result.timedOut, true);
    assertStringIncludes(result.stdout, "got-term");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runLego escalates to SIGKILL when lego ignores SIGTERM", async () => {
  const { path, dir } = await script(
    "trap '' TERM; while :; do sleep 0.05; done",
  );
  try {
    const started = Date.now();
    const result = await runLego(path, [], {}, {
      signal: new AbortController().signal,
      timeoutMs: 200,
      killGraceMs: 300,
    });
    assertEquals(result.timedOut, true);
    assert(Date.now() - started < 5_000);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runLego stops lego when the method is aborted", async () => {
  const { path, dir } = await script(
    "trap 'exit 143' TERM; while :; do sleep 0.05; done",
  );
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 200);
    await assertRejects(
      () =>
        runLego(path, [], {}, {
          signal: controller.signal,
          timeoutMs: 60_000,
        }),
      Error,
      "cancelled",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
