import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  accountId,
  certName,
  childEnv,
  normaliseServer,
  revokeArgs,
  runArgs,
  type RunOptions,
} from "./lego_args.ts";

const BASE: RunOptions = {
  path: "/tmp/lego-x",
  server: "https://acme-staging-v02.api.letsencrypt.org/directory",
  accountId: "me@example.com",
  email: "me@example.com",
  keyType: "EC256",
  certName: "example.com",
  domains: ["example.com", "www.example.com"],
  dnsProvider: "mythicbeasts",
};

Deno.test("runArgs builds the minimal lego run command", () => {
  assertEquals(runArgs(BASE), [
    "run",
    "--path",
    "/tmp/lego-x",
    "--server",
    "https://acme-staging-v02.api.letsencrypt.org/directory",
    "--accept-tos",
    "--account-id",
    "me@example.com",
    "--email",
    "me@example.com",
    "--key-type",
    "EC256",
    "--cert.name",
    "example.com",
    "-d",
    "example.com",
    "-d",
    "www.example.com",
    "--dns",
    "mythicbeasts",
    "--force-cert-domains",
    "--no-random-sleep",
    "--log.format",
    "text",
  ]);
});

Deno.test("runArgs adds each optional flag", () => {
  const args = runArgs({
    ...BASE,
    email: undefined,
    profile: "shortlived",
    preferredChain: "ISRG Root X1",
    renewDays: 30,
    renewForce: true,
    dnsResolvers: ["1.1.1.1:53", "9.9.9.9:53"],
    dnsTimeout: 20,
    dnsPropagationWait: "90s",
    dnsPropagationDisableAns: true,
    dnsPropagationDisableRns: true,
    eabKid: "kid-123",
  });
  assert(!args.includes("--email"));
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assertEquals(after("--profile"), "shortlived");
  assertEquals(after("--preferred-chain"), "ISRG Root X1");
  assertEquals(after("--renew-days"), "30");
  assert(args.includes("--renew-force"));
  assertEquals(after("--dns.resolvers"), "1.1.1.1:53,9.9.9.9:53");
  assertEquals(after("--dns.timeout"), "20");
  assertEquals(after("--dns.propagation.wait"), "90s");
  assert(args.includes("--dns.propagation.disable-ans"));
  assert(args.includes("--dns.propagation.disable-rns"));
  assert(args.includes("--eab"));
  assertEquals(after("--eab.kid"), "kid-123");
  assert(!args.some((a) => a.startsWith("--eab.hmac")));
});

Deno.test("runArgs omits EAB when no kid is set", () => {
  assert(!runArgs(BASE).some((a) => a.startsWith("--eab")));
});

Deno.test("revokeArgs uses only flags lego certificates revoke accepts", () => {
  assertEquals(
    revokeArgs({
      path: "/tmp/lego-x",
      server: BASE.server,
      accountId: "me@example.com",
      email: "me@example.com",
      accountKeyType: "EC384",
      certName: "_.example.com",
      reason: 4,
    }),
    [
      "certificates",
      "revoke",
      "--path",
      "/tmp/lego-x",
      "--server",
      BASE.server,
      "--account-id",
      "me@example.com",
      "--email",
      "me@example.com",
      "--key-type",
      "EC384",
      "--cert.name",
      "_.example.com",
      "--keep",
      "--reason",
      "4",
      "--log.format",
      "text",
    ],
  );
});

Deno.test("revokeArgs leaves out what it does not know", () => {
  const args = revokeArgs({
    path: "/p",
    server: BASE.server,
    accountId: "swamp",
    certName: "example.com",
    reason: 0,
  });
  assert(!args.includes("--email"));
  assert(!args.includes("--key-type"));
});

Deno.test("certName defaults to the first domain with * as _", () => {
  assertEquals(certName(["*.example.com", "example.com"]), "_.example.com");
  assertEquals(certName(["example.com"]), "example.com");
  assertEquals(certName(["a.example.com"], "mine"), "mine");
});

Deno.test("certName refuses names that would leave certificates/", () => {
  for (const name of ["../x", "a/b", "..", ".", "", "x\0y", ".hidden"]) {
    assertThrows(() => certName(["example.com"], name), Error, "name", name);
  }
});

Deno.test("accountId is the email, or 'swamp' without one", () => {
  assertEquals(accountId("me@example.com"), "me@example.com");
  assertEquals(accountId(undefined), "swamp");
});

Deno.test("normaliseServer trims trailing slashes only", () => {
  assertEquals(
    normaliseServer("https://acme.example/directory/"),
    "https://acme.example/directory",
  );
  assertEquals(
    normaliseServer("https://acme.example/directory"),
    "https://acme.example/directory",
  );
});

const PARENT = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  AWS_PROFILE: "dev",
  AWS_ACCESS_KEY_ID: "AKIA",
  LEGO_CA_CERTIFICATES: "/etc/ca.pem",
  LEGO_ACCOUNT_ID: "someone-else",
  LEGO_ENV_FILE: "/etc/lego.env",
  SECRET_TOKEN: "do-not-pass",
};

Deno.test("childEnv passes only the allowlist by default", () => {
  assertEquals(
    childEnv({ parentEnv: PARENT, ambientCredentials: false, dnsEnv: {} }),
    {
      PATH: "/usr/bin",
      HOME: "/home/me",
      AWS_PROFILE: "dev",
      LEGO_CA_CERTIFICATES: "/etc/ca.pem",
    },
  );
});

Deno.test("childEnv passes the parent through with ambient credentials, less LEGO_*", () => {
  assertEquals(
    childEnv({ parentEnv: PARENT, ambientCredentials: true, dnsEnv: {} }),
    {
      PATH: "/usr/bin",
      HOME: "/home/me",
      AWS_PROFILE: "dev",
      AWS_ACCESS_KEY_ID: "AKIA",
      LEGO_CA_CERTIFICATES: "/etc/ca.pem",
      SECRET_TOKEN: "do-not-pass",
    },
  );
});

Deno.test("childEnv overlays DNS settings, the EAB hmac and trace headers", () => {
  const env = childEnv({
    parentEnv: PARENT,
    ambientCredentials: false,
    dnsEnv: {
      AWS_PROFILE: "prod",
      MYTHICBEASTS_PASSWORD: "pa$$word \\ # with\nnewline \"quoted\"",
    },
    eabHmac: "hmac-secret",
    traceHeaders: { traceparent: "00-abc-def-01", tracestate: "k=v" },
  });
  assertEquals(env.AWS_PROFILE, "prod");
  assertEquals(
    env.MYTHICBEASTS_PASSWORD,
    "pa$$word \\ # with\nnewline \"quoted\"",
  );
  assertEquals(env.LEGO_EAB_HMAC, "hmac-secret");
  assertEquals(env.TRACEPARENT, "00-abc-def-01");
  assertEquals(env.TRACESTATE, "k=v");
});

Deno.test("childEnv refuses DNS settings that would set lego flags", () => {
  assertThrows(
    () =>
      childEnv({
        parentEnv: {},
        ambientCredentials: false,
        dnsEnv: { LEGO_ACCOUNT_ID: "x" },
      }),
    Error,
    "LEGO_ACCOUNT_ID",
  );
  assertThrows(
    () =>
      childEnv({
        parentEnv: {},
        ambientCredentials: false,
        dnsEnv: { "not a name": "x" },
      }),
    Error,
    "not a name",
  );
});
