// A stand-in for the lego 5.6.0 binary, for the behavior's tests. It
// accepts only the flags the real subcommands accept, writes lego's v5
// file layout (captured from a real `lego accounts register` against Let's
// Encrypt staging), and follows lego's issue / renew / force-cert-domains
// rules. It never touches the network.
//
// Controls, read from the environment the behavior gives it:
//   FAKE_LEGO_CALLS  file to append each invocation's argv to, as JSON lines
//   FAKE_LEGO_FAIL   "before-register" | "after-register" | "on-revoke" |
//                    "hang-after-register" (touches FAKE_LEGO_CALLS.registered)
import { X509Certificate } from "node:crypto";
import {
  ISSUER,
  PAIR_1,
  PAIR_2,
  RENAMED,
  THREE_NAMES,
  WILDCARD,
} from "./certificates.ts";

const RUN_VALUE_FLAGS = new Set([
  "--path",
  "--server",
  "--account-id",
  "--email",
  "--key-type",
  "--cert.name",
  "-d",
  "--dns",
  "--dns.resolvers",
  "--dns.timeout",
  "--dns.propagation.wait",
  "--profile",
  "--preferred-chain",
  "--renew-days",
  "--eab.kid",
  "--log.format",
]);
const RUN_BOOL_FLAGS = new Set([
  "--accept-tos",
  "--force-cert-domains",
  "--no-random-sleep",
  "--renew-force",
  "--dns.propagation.disable-ans",
  "--dns.propagation.disable-rns",
  "--eab",
]);
const REVOKE_VALUE_FLAGS = new Set([
  "--path",
  "--server",
  "--account-id",
  "--email",
  "--key-type",
  "--cert.name",
  "--reason",
  "--log.format",
]);
const REVOKE_BOOL_FLAGS = new Set(["--keep"]);

const MYTHICBEASTS_HELP = `Configuration for MythicBeasts.
Code:   'mythicbeasts'

Credentials:
  - "MYTHICBEASTS_PASSWORD":  Password
  - "MYTHICBEASTS_USERNAME":  User name

More information: https://go-acme.github.io/lego/dns/mythicbeasts
`;

// Fixtures by the sorted domain set they cover; renewals of PAIR_1 give
// PAIR_2 and back, so a renewal always changes the certificate.
const FIXTURES: Record<string, string[]> = {
  "example.com,www.example.com": [PAIR_1, PAIR_2],
  "*.example.com,example.com": [WILDCARD],
  "api.example.com,example.com,www.example.com": [THREE_NAMES],
  "example.com,new.example.com": [RENAMED],
};

function fail(message: string, code = 1): never {
  console.error(message);
  Deno.exit(code);
}

function parse(
  args: string[],
  valueFlags: Set<string>,
  boolFlags: Set<string>,
) {
  const values: Record<string, string[]> = {};
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (valueFlags.has(flag)) {
      if (i + 1 >= args.length) fail(`flag needs an argument: ${flag}`);
      (values[flag] ??= []).push(args[++i]);
    } else if (boolFlags.has(flag)) {
      bools.add(flag);
    } else {
      fail(`flag provided but not defined: ${flag}`);
    }
  }
  return { values, bools };
}

function domainsOf(pem: string): string[] {
  return new X509Certificate(pem).subjectAltName!.split(", ")
    .map((entry) => entry.slice("DNS:".length));
}

function mkdirFor(path: string) {
  Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
}

function account(path: string, server: string, id: string, email?: string) {
  const dir = `${path}/accounts/${new URL(server).host}/${id}`;
  return { dir, json: `${dir}/account.json`, key: `${dir}/${id}.key`, email };
}

function ensureAccount(
  path: string,
  server: string,
  id: string,
  email?: string,
) {
  const acct = account(path, server, id, email);
  let existing: { registration: unknown } | undefined;
  try {
    existing = JSON.parse(Deno.readTextFileSync(acct.json));
  } catch {
    existing = undefined;
  }
  if (existing?.registration) return;
  mkdirFor(acct.json);
  Deno.writeTextFileSync(
    acct.key,
    `-----BEGIN PRIVATE KEY-----\nFAKE ACCOUNT KEY ${crypto.randomUUID()}\n-----END PRIVATE KEY-----\n`,
    { mode: 0o600 },
  );
  const body = (registration: unknown) =>
    JSON.stringify(
      {
        id,
        email: email ?? "",
        keyType: "EC256",
        server,
        origin: "command",
        registration,
      },
      null,
      "\t",
    );
  Deno.writeTextFileSync(acct.json, body(null), { mode: 0o600 });
  if (Deno.env.get("FAKE_LEGO_FAIL") === "before-register") {
    fail("acme: error presenting registration: connection refused");
  }
  Deno.writeTextFileSync(
    acct.json,
    body({
      status: "valid",
      accountURL: `${server}/acct/${Math.floor(Math.random() * 1e9)}`,
    }),
    { mode: 0o600 },
  );
  console.log(`time=x level=INFO msg="Account registered." id=${id}`);
}

async function run(args: string[]) {
  const { values, bools } = parse(args, RUN_VALUE_FLAGS, RUN_BOOL_FLAGS);
  const one = (flag: string) => values[flag]?.[0];
  const path = one("--path") ?? fail("--path is required");
  const server = one("--server") ?? fail("--server is required");
  const name = one("--cert.name") ?? fail("--cert.name is required");
  const domains = values["-d"] ?? fail("no domains");
  if (!bools.has("--accept-tos")) fail("terms of service not accepted");
  if (one("--dns") !== "mythicbeasts") fail("unsupported DNS provider");
  if (!Deno.env.get("MYTHICBEASTS_PASSWORD")) {
    fail("mythicbeasts: some credentials information are missing");
  }

  ensureAccount(path, server, one("--account-id")!, one("--email"));
  if (Deno.env.get("FAKE_LEGO_FAIL") === "after-register") {
    fail("acme: error: 400 :: urn:ietf:params:acme:error:dns");
  }
  if (Deno.env.get("FAKE_LEGO_FAIL") === "hang-after-register") {
    // Stand in for a slow DNS propagation wait, until lego is stopped.
    Deno.writeTextFileSync(`${Deno.env.get("FAKE_LEGO_CALLS")}.registered`, "");
    while (true) await new Promise((r) => setTimeout(r, 50));
  }

  const crt = `${path}/certificates/${name}.crt`;
  let current: string | undefined;
  try {
    current = Deno.readTextFileSync(crt);
  } catch {
    current = undefined;
  }
  const wanted = [...domains].sort().join(",");
  if (current) {
    const have = domainsOf(current).sort().join(",");
    const mismatch = bools.has("--force-cert-domains") && have !== wanted;
    if (!mismatch && !bools.has("--renew-force")) {
      console.log(
        `time=x level=INFO msg="Skip renewal: the certificate expires in more than 30 days." name=${name}`,
      );
      return;
    }
  }
  const choices = FIXTURES[wanted] ?? fail(`no fixture for ${wanted}`);
  const leaf = choices.find((c) => !current?.startsWith(c)) ?? choices[0];
  mkdirFor(crt);
  Deno.writeTextFileSync(crt, leaf + ISSUER);
  Deno.writeTextFileSync(`${path}/certificates/${name}.issuer.crt`, ISSUER);
  Deno.writeTextFileSync(
    `${path}/certificates/${name}.key`,
    `-----BEGIN PRIVATE KEY-----\nFAKE CERT KEY ${crypto.randomUUID()}\n-----END PRIVATE KEY-----\n`,
    { mode: 0o600 },
  );
  Deno.writeTextFileSync(
    `${path}/certificates/${name}.json`,
    JSON.stringify({ domain: domains[0], certURL: `${server}/cert/x` }),
  );
  console.log(
    `time=x level=INFO msg="Server responded with a certificate." name=${name}`,
  );
}

function revoke(args: string[]) {
  const { values, bools } = parse(args, REVOKE_VALUE_FLAGS, REVOKE_BOOL_FLAGS);
  const one = (flag: string) => values[flag]?.[0];
  const path = one("--path") ?? fail("--path is required");
  const server = one("--server") ?? fail("--server is required");
  const name = one("--cert.name") ?? fail("--cert.name is required");
  const acct = account(path, server, one("--account-id")!);
  try {
    if (!JSON.parse(Deno.readTextFileSync(acct.json)).registration) throw 0;
  } catch {
    fail("Please accept the terms of service (account not registered)");
  }
  try {
    Deno.statSync(`${path}/certificates/${name}.crt`);
  } catch {
    fail(`certificate ${name} not found`);
  }
  if (Deno.env.get("FAKE_LEGO_FAIL") === "on-revoke") {
    fail("acme: error: 403 :: urn:ietf:params:acme:error:unauthorized");
  }
  if (!bools.has("--keep")) {
    Deno.mkdirSync(`${path}/archives`, { recursive: true });
    for (const suffix of [".crt", ".issuer.crt", ".key", ".json"]) {
      Deno.renameSync(
        `${path}/certificates/${name}${suffix}`,
        `${path}/archives/${name}${suffix}`,
      );
    }
  }
  console.log(`time=x level=INFO msg="Certificate was revoked." name=${name}`);
}

const args = Deno.args;
const calls = Deno.env.get("FAKE_LEGO_CALLS");
if (calls) {
  Deno.writeTextFileSync(calls, JSON.stringify(args) + "\n", { append: true });
}

if (args[0] === "--version") {
  console.log("lego version 5.6.0 fake/test");
} else if (args[0] === "dnshelp") {
  if (args[2] !== "mythicbeasts") fail(`unsupported DNS provider: ${args[2]}`);
  console.log(MYTHICBEASTS_HELP);
} else if (args[0] === "run") {
  await run(args.slice(1));
} else if (args[0] === "certificates" && args[1] === "revoke") {
  revoke(args.slice(2));
} else {
  fail(`unknown command: ${args.join(" ")}`);
}
