/**
 * One ACME certificate, issued and renewed by the lego v5 CLI through any
 * of lego's DNS-01 providers. Swamp keeps all of lego's state: each run
 * restores it into a fresh temporary directory, runs lego, saves what
 * changed and deletes the directory.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { daysRemaining, parseBundle } from "./cert_info.ts";
import {
  accountId,
  certName,
  childEnv,
  normaliseServer,
  revokeArgs,
  runArgs,
} from "./lego_args.ts";
import {
  dnsCredentials,
  hasDnsCredential,
  type LegoResult,
  legoVersion,
  runLego,
} from "./lego_runner.ts";
import {
  certificateFiles,
  digest,
  type FileSet,
  restore,
  snapshot,
} from "./lego_state.ts";

/** Let's Encrypt's staging directory, the default server. */
export const LETS_ENCRYPT_STAGING =
  "https://acme-staging-v02.api.letsencrypt.org/directory";

const KEY_TYPES = [
  "EC256",
  "EC384",
  "RSA2048",
  "RSA3072",
  "RSA4096",
  "RSA8192",
] as const;

const GlobalArgsSchema = z.object({
  domains: z.array(z.string().min(1)).min(1).describe(
    "Names the certificate covers; wildcards such as *.example.com allowed",
  ),
  certName: z.string().min(1).optional().describe(
    "lego's name for the certificate; default the first domain, * as _",
  ),
  email: z.email().optional().describe(
    "ACME account contact; also the account id. Without it the id is 'swamp'",
  ),
  server: z.url({ protocol: /^https$/ }).default(LETS_ENCRYPT_STAGING)
    .describe("ACME directory URL (lego shortcodes are not accepted)"),
  keyType: z.enum(KEY_TYPES).default("EC256").describe(
    "Key type of the certificate's private key",
  ),
  profile: z.string().min(1).optional().describe(
    "ACME profile to request, when the CA offers profiles",
  ),
  preferredChain: z.string().min(1).optional().describe(
    "Issuer common name of the chain to prefer",
  ),
  renewDays: z.int().positive().optional().describe(
    "Renew when fewer days than this remain; default lego's dynamic window",
  ),
  eabKid: z.string().min(1).optional().describe(
    "External Account Binding key id, for CAs that require it",
  ),
  eabHmac: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "External Account Binding HMAC key; from a vault",
  ),
  dnsProvider: z.string().min(1).describe(
    "lego DNS provider code, e.g. mythicbeasts, cloudflare, route53",
  ),
  dnsEnv: z.record(z.string(), z.string()).default({}).describe(
    "Non-secret provider settings, by environment variable name",
  ),
  // Sensitive as a whole and per value: swamp refuses literals per value,
  // and its metadata reports only the field's own marker.
  dnsSecretEnv: z.record(z.string(), z.string().meta({ sensitive: true }))
    .default({}).meta({ sensitive: true }).describe(
      "Provider credentials, by environment variable name; from a vault",
    ),
  dnsResolvers: z.array(z.string().min(1)).optional().describe(
    "Resolvers for propagation checks, as host:port",
  ),
  dnsTimeout: z.int().positive().optional().describe(
    "DNS query timeout in seconds",
  ),
  dnsPropagationWait: z.string().regex(/^\d+(ms|s|m|h)$/).optional()
    .describe("Skip propagation checks and wait this long instead, e.g. 90s"),
  dnsPropagationDisableAns: z.boolean().default(false).describe(
    "Do not wait for the authoritative name servers",
  ),
  dnsPropagationDisableRns: z.boolean().default(false).describe(
    "Do not wait for the recursive resolvers",
  ),
  ambientCredentials: z.boolean().default(false).describe(
    "Give lego swamp's whole environment, for credential chains",
  ),
  legoPath: z.string().min(1).default("lego").describe(
    "The lego 5 binary, by path or name on PATH",
  ),
  timeoutSeconds: z.int().positive().default(600).describe(
    "How long one lego run may take",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AccountSchema = z.object({
  server: z.string().describe("ACME directory URL the account is on"),
  accountId: z.string().describe("lego's account id"),
  email: z.string().optional().describe("Contact email, if any"),
  keyType: z.string().optional().describe("The account key's type"),
  accountUrl: z.string().optional().describe("The account's URL at the CA"),
  files: z.record(z.string(), z.string()).describe(
    "lego's public account files, by path under --path",
  ),
  secretFiles: z.record(z.string(), z.string().meta({ sensitive: true }))
    .describe("lego's account key and any other non-public account file"),
});

type Account = z.infer<typeof AccountSchema>;

const CertificateSchema = z.object({
  certName: z.string().describe("lego's name for the certificate"),
  server: z.string().describe("ACME directory URL that issued it"),
  accountId: z.string().describe("lego account id that issued it"),
  domains: z.array(z.string()).describe("DNS names in the certificate"),
  serial: z.string().describe("Serial number, hex"),
  notBefore: z.string().describe("Start of validity, ISO 8601"),
  notAfter: z.string().describe("End of validity, ISO 8601"),
  issuer: z.string().describe("Issuer distinguished name"),
  fingerprintSha256: z.string().describe("SHA-256 fingerprint, hex"),
  certificatePem: z.string().describe("The leaf certificate, PEM"),
  chainPem: z.string().describe("Intermediate certificates, PEM"),
  privateKeyPem: z.string().meta({ sensitive: true }).describe(
    "The certificate's private key, PEM",
  ),
  legoFiles: z.record(z.string(), z.string()).describe(
    "lego's public certificate files, by path under --path",
  ),
  legoSecretFiles: z.record(z.string(), z.string().meta({ sensitive: true }))
    .describe("Other non-public certificate files, besides the key"),
  issuedAt: z.string().describe("When swamp saved this certificate"),
  revokedAt: z.string().nullable().describe("When it was revoked, if it was"),
  revocationReason: z.int().optional().describe("RFC 5280 reason code"),
});

type Certificate = z.infer<typeof CertificateSchema>;

const CERTIFICATE_INSTANCE = "certificate";

interface Logger {
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
}

interface Context {
  globalArgs: Record<string, unknown>;
  signal: AbortSignal;
  logger: Logger;
  traceHeaders?: Readonly<Record<string, string>>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
  ) => { writeText(text: string): Promise<{ name: string }> };
}

/** The account resource instance for a server and account id. */
export async function accountInstance(
  server: string,
  id: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${normaliseServer(server)}\n${id}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(
    hash.slice(0, 8),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
  return `account-${hex}`;
}

async function readStored<T>(
  context: Context,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const raw = await context.readResource?.(name);
  if (!raw) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    context.logger.warning("Ignoring stored {name}, which does not parse", {
      name,
    });
    return undefined;
  }
  return parsed.data;
}

function keyPath(name: string): string {
  return `certificates/${name}.key`;
}

/** The registered account lego left under accounts/, if any. */
function registeredAccount(set: FileSet) {
  for (const [path, content] of Object.entries(set.files)) {
    if (!path.endsWith("/account.json")) continue;
    try {
      const json = JSON.parse(content);
      if (json?.registration) {
        return {
          keyType: typeof json.keyType === "string" ? json.keyType : undefined,
          accountUrl: typeof json.registration.accountURL === "string"
            ? json.registration.accountURL
            : undefined,
        };
      }
    } catch {
      // not lego's JSON: treat as unregistered
    }
  }
  return undefined;
}

function failure(command: string, result: LegoResult): Error {
  const tail = (result.stderr || result.stdout).trim().split("\n").slice(-5)
    .join("\n");
  const why = result.timedOut ? "timed out" : `exited ${result.code}`;
  return new Error(`lego ${command} ${why}:\n${tail}`);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lego-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeLog(
  context: Context,
  name: string,
  version: string,
  result: LegoResult,
) {
  await context.createFileWriter("log", name).writeText(
    `lego ${version}, exit ${result.code}${
      result.timedOut ? " (timed out)" : ""
    }\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
}

function storedCertificateFiles(cert: Certificate): FileSet {
  return {
    files: cert.legoFiles,
    secretFiles: {
      ...cert.legoSecretFiles,
      [keyPath(cert.certName)]: cert.privateKeyPem,
    },
  };
}

async function apply(
  args: { forceRenew: boolean },
  context: Context,
): Promise<{ dataHandles: { name: string }[] }> {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const server = normaliseServer(g.server);
  const name = certName(g.domains, g.certName);
  const id = accountId(g.email);
  const accountName = await accountInstance(server, id);
  const env = childEnv({
    parentEnv: Deno.env.toObject(),
    ambientCredentials: g.ambientCredentials,
    dnsEnv: { ...g.dnsEnv, ...g.dnsSecretEnv },
    eabHmac: g.eabHmac,
    traceHeaders: context.traceHeaders,
  });
  const version = await legoVersion(g.legoPath);
  const storedAccount = await readStored(context, accountName, AccountSchema);
  const storedCert = await readStored(
    context,
    CERTIFICATE_INSTANCE,
    CertificateSchema,
  );

  return await withTempDir(async (dir) => {
    if (
      storedAccount && normaliseServer(storedAccount.server) === server &&
      storedAccount.accountId === id
    ) {
      await restore(dir, storedAccount, "accounts");
    }
    const reuseCert = storedCert && storedCert.revokedAt === null &&
      normaliseServer(storedCert.server) === server &&
      storedCert.certName === name && storedCert.accountId === id;
    if (storedCert && !reuseCert) {
      context.logger.info(
        "Not reusing the stored certificate {stored}: it was issued for " +
          "another server, name or account, or revoked",
        { stored: storedCert.certName },
      );
    }
    if (reuseCert) {
      await restore(dir, storedCertificateFiles(storedCert), "certificates");
    }
    const accountBefore = await digest(await snapshot(dir, "accounts"));
    const certBefore = await digest(await snapshot(dir, "certificates"));

    context.logger.info("Running lego {version} for {name} ({domains})", {
      version,
      name,
      domains: g.domains.join(", "),
    });
    const result = await runLego(
      g.legoPath,
      runArgs({
        path: dir,
        server,
        accountId: id,
        email: g.email,
        keyType: g.keyType,
        certName: name,
        domains: g.domains,
        dnsProvider: g.dnsProvider,
        profile: g.profile,
        preferredChain: g.preferredChain,
        renewDays: g.renewDays,
        renewForce: args.forceRenew,
        dnsResolvers: g.dnsResolvers,
        dnsTimeout: g.dnsTimeout,
        dnsPropagationWait: g.dnsPropagationWait,
        dnsPropagationDisableAns: g.dnsPropagationDisableAns,
        dnsPropagationDisableRns: g.dnsPropagationDisableRns,
        eabKid: g.eabKid,
      }),
      env,
      { signal: context.signal, timeoutMs: g.timeoutSeconds * 1000 },
    );
    await writeLog(context, "apply", version, result);
    const handles: { name: string }[] = [];

    // Keep a newly registered account even when lego then failed, so the
    // retry reuses it instead of registering another.
    const accounts = await snapshot(dir, "accounts");
    const registered = registeredAccount(accounts);
    if (registered && await digest(accounts) !== accountBefore) {
      const account: Account = {
        server,
        accountId: id,
        email: g.email,
        keyType: registered.keyType,
        accountUrl: registered.accountUrl,
        ...accounts,
      };
      handles.push(
        await context.writeResource("account", accountName, account),
      );
      context.logger.info("Saved ACME account {id} on {server}", {
        id,
        server,
      });
    }

    if (result.code !== 0 || result.timedOut) throw failure("run", result);

    const certs = certificateFiles(await snapshot(dir, "certificates"), name);
    if (await digest(certs) === certBefore) {
      context.logger.info("Certificate {name} is not due for renewal", {
        name,
      });
      return { dataHandles: handles };
    }
    const bundle = certs.files[`certificates/${name}.crt`];
    const privateKeyPem = certs.secretFiles[keyPath(name)];
    if (!bundle || !privateKeyPem) {
      throw new Error(
        `lego exited 0 but left no certificate or key for '${name}'`,
      );
    }
    const info = parseBundle(bundle);
    const wanted = new Set(g.domains.map((d) => d.toLowerCase()));
    const got = new Set(info.domains.map((d) => d.toLowerCase()));
    if (wanted.size !== got.size || [...wanted].some((d) => !got.has(d))) {
      context.logger.warning(
        "The certificate covers {got}, not the requested {wanted}",
        { got: info.domains.join(", "), wanted: g.domains.join(", ") },
      );
    }
    const legoSecretFiles = { ...certs.secretFiles };
    delete legoSecretFiles[keyPath(name)];
    const cert: Certificate = {
      certName: name,
      server,
      accountId: id,
      domains: info.domains,
      serial: info.serial,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      issuer: info.issuer,
      fingerprintSha256: info.fingerprintSha256,
      certificatePem: info.leafPem,
      chainPem: info.chainPem,
      privateKeyPem,
      legoFiles: certs.files,
      legoSecretFiles,
      issuedAt: new Date().toISOString(),
      revokedAt: null,
    };
    handles.push(
      await context.writeResource("certificate", CERTIFICATE_INSTANCE, cert),
    );
    context.logger.info(
      "Saved certificate {name}, serial {serial}, valid until {notAfter}",
      { name, serial: info.serial, notAfter: info.notAfter },
    );
    return { dataHandles: handles };
  });
}

async function revoke(
  args: { reason: number },
  context: Context,
): Promise<{ dataHandles: { name: string }[] }> {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const cert = await readStored(
    context,
    CERTIFICATE_INSTANCE,
    CertificateSchema,
  );
  if (!cert) throw new Error("There is no certificate to revoke");
  if (cert.revokedAt !== null) {
    throw new Error(
      `Certificate ${cert.certName} (serial ${cert.serial}) was already ` +
        `revoked at ${cert.revokedAt}`,
    );
  }
  // Revoke with the account and CA that issued it, whatever the global
  // arguments say now.
  const accountName = await accountInstance(cert.server, cert.accountId);
  const account = await readStored(context, accountName, AccountSchema);
  if (!account) {
    throw new Error(
      `There is no stored account ${cert.accountId} on ${cert.server} to ` +
        `revoke certificate ${cert.certName} with`,
    );
  }
  const env = childEnv({
    parentEnv: Deno.env.toObject(),
    ambientCredentials: g.ambientCredentials,
    dnsEnv: { ...g.dnsEnv, ...g.dnsSecretEnv },
    eabHmac: g.eabHmac,
    traceHeaders: context.traceHeaders,
  });
  const version = await legoVersion(g.legoPath);

  return await withTempDir(async (dir) => {
    await restore(dir, account, "accounts");
    await restore(dir, storedCertificateFiles(cert), "certificates");
    const result = await runLego(
      g.legoPath,
      revokeArgs({
        path: dir,
        server: cert.server,
        accountId: cert.accountId,
        email: account.email,
        accountKeyType: account.keyType,
        certName: cert.certName,
        reason: args.reason,
      }),
      env,
      { signal: context.signal, timeoutMs: g.timeoutSeconds * 1000 },
    );
    await writeLog(context, "revoke", version, result);
    if (result.code !== 0 || result.timedOut) throw failure("revoke", result);
    const revoked: Certificate = {
      ...cert,
      revokedAt: new Date().toISOString(),
      revocationReason: args.reason,
    };
    context.logger.info("Revoked certificate {name}, serial {serial}", {
      name: cert.certName,
      serial: cert.serial,
    });
    return {
      dataHandles: [
        await context.writeResource(
          "certificate",
          CERTIFICATE_INSTANCE,
          revoked,
        ),
      ],
    };
  });
}

async function status(
  _args: Record<string, never>,
  context: Context,
): Promise<{ dataHandles: { name: string }[] }> {
  const cert = await readStored(
    context,
    CERTIFICATE_INSTANCE,
    CertificateSchema,
  );
  if (!cert) {
    context.logger.info("There is no certificate yet; run apply");
    return { dataHandles: [] };
  }
  context.logger.info(
    "Certificate {name} for {domains}: serial {serial}, valid until " +
      "{notAfter}, {daysRemaining} days remaining{revoked}",
    {
      name: cert.certName,
      domains: cert.domains.join(", "),
      serial: cert.serial,
      notAfter: cert.notAfter,
      daysRemaining: daysRemaining(cert.notAfter, new Date()),
      revoked: cert.revokedAt ? `, revoked at ${cert.revokedAt}` : "",
    },
  );
  return { dataHandles: [] };
}

interface CheckContext {
  globalArgs: Record<string, unknown>;
}

/** Behavior definition for one ACME certificate managed with lego. */
export const behavior = {
  type: "@zts/lego-certificate",
  version: "2026.11.01.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "account": {
      description: "An ACME account lego registered, one per CA and account id",
      schema: AccountSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "certificate": {
      description: "The current certificate, its key and lego's files for it",
      schema: CertificateSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    "log": {
      description: "lego's output from the last run",
      contentType: "text/plain",
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  checks: {
    "lego-binary": {
      description: "lego 5 is installed at legoPath",
      labels: ["dependency"],
      execute: async (context: CheckContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        try {
          await legoVersion(g.legoPath);
          return { pass: true };
        } catch (error) {
          return { pass: false, errors: [(error as Error).message] };
        }
      },
    },
    "dns-credentials": {
      description: "At least one of the DNS provider's credentials is set",
      labels: ["policy"],
      appliesTo: ["apply"],
      execute: async (context: CheckContext) => {
        const g = GlobalArgsSchema.parse(context.globalArgs);
        if (g.ambientCredentials) return { pass: true };
        try {
          const credentials = await dnsCredentials(g.legoPath, g.dnsProvider);
          const env = childEnv({
            parentEnv: Deno.env.toObject(),
            ambientCredentials: false,
            dnsEnv: { ...g.dnsEnv, ...g.dnsSecretEnv },
          });
          if (hasDnsCredential(credentials, env)) return { pass: true };
          return {
            pass: false,
            errors: [
              `DNS provider ${g.dnsProvider} needs one of ` +
              `${credentials.join(", ")} in dnsEnv or dnsSecretEnv ` +
              `(or set ambientCredentials)`,
            ],
          };
        } catch (error) {
          return { pass: false, errors: [(error as Error).message] };
        }
      },
    },
  },
  methods: {
    apply: {
      description:
        "Issue the certificate, or renew it when lego says it is due, and " +
        "save what changed",
      arguments: z.object({
        forceRenew: z.boolean().default(false).describe(
          "Renew now even when the certificate is not due",
        ),
      }),
      execute: (args: { forceRenew?: boolean }, context: Context) =>
        apply({ forceRenew: args.forceRenew ?? false }, context),
    },
    status: {
      description: "Log the stored certificate's validity; calls nothing",
      kind: "read" as const,
      arguments: z.object({}),
      execute: status,
    },
    revoke: {
      description: "Revoke the stored certificate with the CA that issued it",
      arguments: z.object({
        reason: z.int().min(0).max(10).refine((r) => r !== 7, {
          message: "7 is not a revocation reason code",
        }).default(0).describe("RFC 5280 revocation reason code"),
      }),
      execute: (args: { reason?: number }, context: Context) =>
        revoke({ reason: args.reason ?? 0 }, context),
    },
  },
};
