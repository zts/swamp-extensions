import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { behavior } from "./lego_certificate.ts";

const STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
const PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
const PASSWORD = "s3cr3t-pa$$word";

type Store = Record<string, Record<string, unknown>>;
type MethodName = keyof typeof behavior.methods;

interface Fixture {
  dir: string;
  bin: string;
  callsFile: string;
  globals: Record<string, unknown>;
  store: Store;
}

async function setup(
  overrides: Record<string, unknown> = {},
): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "lego-certificate-test-" });
  const bin = `${dir}/lego`;
  const fake = new URL("./testdata/fake_lego.ts", import.meta.url).pathname;
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\nexec '${Deno.execPath()}' run --quiet --allow-all --no-config '${fake}' "$@"\n`,
    { mode: 0o755 },
  );
  const callsFile = `${dir}/calls.jsonl`;
  return {
    dir,
    bin,
    callsFile,
    store: {},
    globals: {
      domains: ["example.com", "www.example.com"],
      email: "me@example.com",
      server: STAGING,
      dnsProvider: "mythicbeasts",
      dnsEnv: { MYTHICBEASTS_USERNAME: "user", FAKE_LEGO_CALLS: callsFile },
      dnsSecretEnv: { MYTHICBEASTS_PASSWORD: PASSWORD },
      legoPath: bin,
      ...overrides,
    },
  };
}

async function teardown(f: Fixture) {
  await Deno.remove(f.dir, { recursive: true });
}

/** Run a method with the stored resources so far, keeping what it writes. */
async function call(
  f: Fixture,
  method: MethodName,
  args: Record<string, unknown> = {},
  globals: Record<string, unknown> = {},
) {
  const test = createModelTestContext({
    globalArgs: { ...f.globals, ...globals },
    methodName: method,
    storedResources: { ...f.store },
  });
  let error: Error | undefined;
  try {
    // deno-lint-ignore no-explicit-any
    await (behavior.methods[method].execute as any)(args, test.context);
  } catch (e) {
    error = e as Error;
  }
  const written = test.getWrittenResources();
  for (const w of written) f.store[w.name] = w.data;
  return { ...test, written, error };
}

async function calls(f: Fixture): Promise<string[][]> {
  try {
    return (await Deno.readTextFile(f.callsFile)).trim().split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function lastRunArgs(f: Fixture): Promise<string[]> {
  const runs = (await calls(f)).filter((c) => c[0] === "run");
  return runs[runs.length - 1];
}

function certificate(f: Fixture) {
  return f.store["certificate"];
}

function accountNames(f: Fixture) {
  return Object.keys(f.store).filter((name) => name.startsWith("account-"));
}

async function tempDirsLeft(): Promise<number> {
  const tmp = await Deno.makeTempDir();
  const parent = tmp.slice(0, tmp.lastIndexOf("/"));
  await Deno.remove(tmp);
  let count = 0;
  for await (const entry of Deno.readDir(parent)) {
    if (entry.name.startsWith("swamp-lego-")) count++;
  }
  return count;
}

Deno.test("apply issues a certificate and registers an account", async () => {
  const f = await setup();
  try {
    const { written, error, getWrittenFiles } = await call(f, "apply");
    assertEquals(error, undefined);
    assertEquals(written.map((w) => w.specName).sort(), [
      "account",
      "certificate",
    ]);

    const cert = certificate(f);
    assertEquals(cert.certName, "example.com");
    assertEquals(cert.server, STAGING);
    assertEquals(cert.accountId, "me@example.com");
    assertEquals(cert.domains, ["example.com", "www.example.com"]);
    assertEquals(cert.serial, "01");
    assertEquals(cert.issuer, "CN=Fixture Test CA");
    assertEquals(cert.revokedAt, null);
    assertStringIncludes(cert.privateKeyPem as string, "FAKE CERT KEY");
    assertStringIncludes(cert.certificatePem as string, "BEGIN CERTIFICATE");
    assertStringIncludes(cert.chainPem as string, "BEGIN CERTIFICATE");
    assertEquals(Object.keys(cert.legoFiles as object).sort(), [
      "certificates/example.com.crt",
      "certificates/example.com.issuer.crt",
      "certificates/example.com.json",
    ]);
    assertEquals(cert.legoSecretFiles, {});

    const [name] = accountNames(f);
    const account = f.store[name];
    assertEquals(account.server, STAGING);
    assertEquals(account.accountId, "me@example.com");
    assertEquals(account.email, "me@example.com");
    assertEquals(account.keyType, "EC256");
    assertMatch(account.accountUrl as string, /\/acct\/\d+$/);
    const host = "accounts/acme-staging-v02.api.letsencrypt.org/me@example.com";
    assertEquals(Object.keys(account.files as object), [
      `${host}/account.json`,
    ]);
    assertEquals(Object.keys(account.secretFiles as object), [
      `${host}/me@example.com.key`,
    ]);

    const log = getWrittenFiles().find((w) => w.specName === "log");
    assertExists(log);
    assertStringIncludes(
      new TextDecoder().decode(log.content),
      "Server responded with a certificate",
    );
  } finally {
    await teardown(f);
  }
});

Deno.test("apply passes lego the expected flags and no secret", async () => {
  const f = await setup({ eabKid: "kid-1", eabHmac: "hmac-secret-value" });
  try {
    await call(f, "apply");
    const args = await lastRunArgs(f);
    for (
      const flag of [
        "--accept-tos",
        "--force-cert-domains",
        "--no-random-sleep",
        "--eab",
      ]
    ) {
      assert(args.includes(flag), flag);
    }
    assertEquals(args[args.indexOf("--cert.name") + 1], "example.com");
    assertEquals(args[args.indexOf("--eab.kid") + 1], "kid-1");
    assert(!args.includes("--renew-force"));
    const all = JSON.stringify(await calls(f));
    assert(!all.includes(PASSWORD));
    assert(!all.includes("hmac-secret-value"));
  } finally {
    await teardown(f);
  }
});

Deno.test("a second apply with nothing due writes nothing", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const { written, error } = await call(f, "apply");
    assertEquals(error, undefined);
    assertEquals(written, []);
  } finally {
    await teardown(f);
  }
});

Deno.test("apply with forceRenew writes a new certificate, not a new account", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const before = certificate(f);
    const { written } = await call(f, "apply", { forceRenew: true });
    assertEquals(written.map((w) => w.specName), ["certificate"]);
    assert((await lastRunArgs(f)).includes("--renew-force"));
    assertEquals(certificate(f).serial, "02");
    assertNotEquals(certificate(f).privateKeyPem, before.privateKeyPem);
  } finally {
    await teardown(f);
  }
});

Deno.test("adding a domain reissues, and domains come from the certificate", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const { written } = await call(f, "apply", {}, {
      domains: ["example.com", "www.example.com", "api.example.com"],
    });
    assertEquals(written.map((w) => w.specName), ["certificate"]);
    assertEquals(certificate(f).certName, "example.com");
    assertEquals(certificate(f).domains, [
      "example.com",
      "www.example.com",
      "api.example.com",
    ]);
  } finally {
    await teardown(f);
  }
});

Deno.test("changing the first domain issues under the new name and keeps it", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const { error } = await call(f, "apply", {}, {
      domains: ["new.example.com", "example.com"],
    });
    assertEquals(error, undefined);
    assertEquals(certificate(f).certName, "new.example.com");
    assertEquals(certificate(f).domains, ["new.example.com", "example.com"]);
    // The old certificate was not restored next to the new one.
    assertEquals(
      Object.keys(certificate(f).legoFiles as object).every((p) =>
        p.startsWith("certificates/new.example.com.")
      ),
      true,
    );
    // A later run restores the new one and has nothing to do.
    const again = await call(f, "apply", {}, {
      domains: ["new.example.com", "example.com"],
    });
    assertEquals(again.written, []);
  } finally {
    await teardown(f);
  }
});

Deno.test("a wildcard certificate round-trips under lego's _ name", async () => {
  const f = await setup({ domains: ["*.example.com", "example.com"] });
  try {
    const first = await call(f, "apply");
    assertEquals(first.error, undefined);
    assertEquals(certificate(f).certName, "_.example.com");
    assertEquals(certificate(f).domains, ["*.example.com", "example.com"]);
    assertEquals(Object.keys(certificate(f).legoFiles as object).sort(), [
      "certificates/_.example.com.crt",
      "certificates/_.example.com.issuer.crt",
      "certificates/_.example.com.json",
    ]);
    const again = await call(f, "apply");
    assertEquals(again.error, undefined);
    assertEquals(again.written, []);
  } finally {
    await teardown(f);
  }
});

Deno.test("moving from staging to production, and back, keeps one account per CA", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const toProd = await call(f, "apply", {}, { server: PRODUCTION });
    assertEquals(toProd.error, undefined);
    assertEquals(toProd.written.map((w) => w.specName).sort(), [
      "account",
      "certificate",
    ]);
    assertEquals(certificate(f).server, PRODUCTION);
    assertEquals(accountNames(f).length, 2);

    const back = await call(f, "apply", {}, { server: `${STAGING}/` });
    assertEquals(back.error, undefined);
    // The staging account is reused, and a staging certificate is issued.
    assertEquals(back.written.map((w) => w.specName), ["certificate"]);
    assertEquals(certificate(f).server, STAGING);
  } finally {
    await teardown(f);
  }
});

Deno.test("an account registered before lego fails is kept for the retry", async () => {
  const f = await setup();
  try {
    const failed = await call(f, "apply", {}, {
      dnsEnv: {
        MYTHICBEASTS_USERNAME: "user",
        FAKE_LEGO_CALLS: f.callsFile,
        FAKE_LEGO_FAIL: "after-register",
      },
    });
    assertExists(failed.error);
    assertStringIncludes(
      failed.error.message,
      "urn:ietf:params:acme:error:dns",
    );
    assertEquals(failed.written.map((w) => w.specName), ["account"]);
    assertEquals(certificate(f), undefined);
    assert(
      failed.getWrittenFiles().some((w) => w.specName === "log"),
      "the log is kept on failure",
    );

    const retry = await call(f, "apply");
    assertEquals(retry.error, undefined);
    assertEquals(retry.written.map((w) => w.specName), ["certificate"]);
  } finally {
    await teardown(f);
  }
});

Deno.test("an account lego never registered is not saved", async () => {
  const f = await setup();
  try {
    const failed = await call(f, "apply", {}, {
      dnsEnv: {
        MYTHICBEASTS_USERNAME: "user",
        FAKE_LEGO_FAIL: "before-register",
      },
    });
    assertExists(failed.error);
    assertEquals(failed.written, []);
  } finally {
    await teardown(f);
  }
});

Deno.test("no temporary directory is left behind, on success or failure", async () => {
  const f = await setup();
  try {
    const before = await tempDirsLeft();
    await call(f, "apply");
    await call(f, "apply", {}, { dnsSecretEnv: {} });
    assertEquals(await tempDirsLeft(), before);
  } finally {
    await teardown(f);
  }
});

Deno.test("revoke keeps lego's files and marks the certificate revoked", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const before = certificate(f);
    const { error, written } = await call(f, "revoke", { reason: 4 });
    assertEquals(error, undefined);
    assertEquals(written.map((w) => w.specName), ["certificate"]);
    const revokeCall = (await calls(f)).find((c) => c[0] === "certificates")!;
    assert(revokeCall.includes("--keep"));
    assertEquals(revokeCall[revokeCall.indexOf("--reason") + 1], "4");
    assertEquals(revokeCall[revokeCall.indexOf("--key-type") + 1], "EC256");
    assertMatch(certificate(f).revokedAt as string, /^\d{4}-\d\d-\d\dT/);
    assertEquals(certificate(f).revocationReason, 4);
    assertEquals(certificate(f).serial, before.serial);
    assertEquals(certificate(f).privateKeyPem, before.privateKeyPem);
  } finally {
    await teardown(f);
  }
});

Deno.test("revoke uses the certificate's own CA, not the current server", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const { error } = await call(f, "revoke", {}, { server: PRODUCTION });
    assertEquals(error, undefined);
    const revokeCall = (await calls(f)).find((c) => c[0] === "certificates")!;
    assertEquals(revokeCall[revokeCall.indexOf("--server") + 1], STAGING);
  } finally {
    await teardown(f);
  }
});

Deno.test("revoke refuses when there is nothing to revoke", async () => {
  const f = await setup();
  try {
    const none = await call(f, "revoke");
    assertStringIncludes(none.error!.message, "no certificate");
    await call(f, "apply");
    await call(f, "revoke");
    const twice = await call(f, "revoke");
    assertStringIncludes(twice.error!.message, "already revoked");
    assertEquals(twice.written, []);
  } finally {
    await teardown(f);
  }
});

Deno.test("a failed revoke leaves the certificate unrevoked", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    const failed = await call(f, "revoke", {}, {
      dnsEnv: {
        MYTHICBEASTS_USERNAME: "user",
        FAKE_LEGO_FAIL: "on-revoke",
      },
    });
    assertStringIncludes(failed.error!.message, "unauthorized");
    assertEquals(failed.written, []);
    assertEquals(certificate(f).revokedAt, null);
  } finally {
    await teardown(f);
  }
});

Deno.test("apply after revoke issues a fresh certificate", async () => {
  const f = await setup();
  try {
    await call(f, "apply");
    await call(f, "revoke");
    const { error, written } = await call(f, "apply");
    assertEquals(error, undefined);
    assertEquals(written.map((w) => w.specName), ["certificate"]);
    assertEquals(certificate(f).revokedAt, null);
  } finally {
    await teardown(f);
  }
});

Deno.test("status reports days remaining and writes nothing", async () => {
  const f = await setup();
  try {
    const empty = await call(f, "status");
    assertEquals(empty.error, undefined);
    assertEquals(empty.written, []);
    assertStringIncludes(
      empty.getLogs().map((l) => l.message).join("\n"),
      "no certificate",
    );

    await call(f, "apply");
    const { written, getLogs, error } = await call(f, "status");
    assertEquals(error, undefined);
    assertEquals(written, []);
    assertStringIncludes(
      getLogs().map((l) => JSON.stringify(l)).join("\n"),
      "daysRemaining",
    );
    assertEquals(behavior.methods.status.kind, "read");
  } finally {
    await teardown(f);
  }
});

function checkContext(f: Fixture, globals: Record<string, unknown> = {}) {
  return createModelTestContext({
    globalArgs: { ...f.globals, ...globals },
    methodName: "apply",
  }).context;
}

Deno.test("the lego-binary check needs lego 5 at legoPath", async () => {
  const f = await setup();
  try {
    const check = behavior.checks["lego-binary"];
    assertEquals(await check.execute(checkContext(f)), { pass: true });
    const missing = await check.execute(
      checkContext(f, { legoPath: `${f.dir}/missing-lego` }),
    );
    assertEquals(missing.pass, false);
    assertStringIncludes(missing.errors![0], "legoPath");
  } finally {
    await teardown(f);
  }
});

Deno.test("the dns-credentials check needs one provider credential", async () => {
  const f = await setup();
  try {
    const check = behavior.checks["dns-credentials"];
    assertEquals(check.appliesTo, ["apply"]);
    assertEquals(await check.execute(checkContext(f)), { pass: true });
    const without = await check.execute(
      checkContext(f, { dnsEnv: {}, dnsSecretEnv: {} }),
    );
    assertEquals(without.pass, false);
    assertStringIncludes(without.errors![0], "MYTHICBEASTS_PASSWORD");
    const ambient = await check.execute(
      checkContext(f, {
        dnsEnv: {},
        dnsSecretEnv: {},
        ambientCredentials: true,
      }),
    );
    assertEquals(ambient, { pass: true });
    const unknown = await check.execute(
      checkContext(f, { dnsProvider: "nope" }),
    );
    assertEquals(unknown.pass, false);
  } finally {
    await teardown(f);
  }
});

Deno.test("global arguments refuse a server that is not a URL", () => {
  const parsed = behavior.globalArguments.safeParse({
    domains: ["example.com"],
    dnsProvider: "mythicbeasts",
    server: "letsencrypt",
  });
  assertEquals(parsed.success, false);
});
