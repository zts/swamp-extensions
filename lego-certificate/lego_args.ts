/**
 * Builds the argv and environment for the lego v5 CLI.
 *
 * Secrets never go in argv: DNS credentials and the EAB hmac reach lego
 * only through its environment.
 *
 * @module
 */

/** Options for `lego run`, already resolved from the global arguments. */
export interface RunOptions {
  path: string;
  server: string;
  accountId: string;
  email?: string;
  keyType: string;
  certName: string;
  domains: string[];
  dnsProvider: string;
  profile?: string;
  preferredChain?: string;
  renewDays?: number;
  renewForce?: boolean;
  dnsResolvers?: string[];
  dnsTimeout?: number;
  dnsPropagationWait?: string;
  dnsPropagationDisableAns?: boolean;
  dnsPropagationDisableRns?: boolean;
  /** EAB key id. Its hmac goes in the environment, see {@link childEnv}. */
  eabKid?: string;
}

/** Options for `lego certificates revoke`. */
export interface RevokeOptions {
  path: string;
  server: string;
  accountId: string;
  email?: string;
  /** The account key's type; for revoke, --key-type means the account key. */
  accountKeyType?: string;
  certName: string;
  /** RFC 5280 revocation reason code. */
  reason: number;
}

/** Options for {@link childEnv}. */
export interface ChildEnvOptions {
  parentEnv: Record<string, string>;
  ambientCredentials: boolean;
  /** Provider settings and credentials, by environment variable name. */
  dnsEnv: Record<string, string>;
  eabHmac?: string;
  traceHeaders?: Readonly<Record<string, string>>;
}

// What lego needs from the parent by default: a PATH and HOME, proxies,
// custom trust roots, and pointers to (not values of) credential files.
const ALLOWED_PARENT_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LEGO_CA_CERTIFICATES",
  "LEGO_CA_SERVER_NAME",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

// LEGO_* variables set lego's flags. Only the trust settings, which have no
// flag, may come from the parent.
const PARENT_LEGO_ALLOWED = new Set([
  "LEGO_CA_CERTIFICATES",
  "LEGO_CA_SERVER_NAME",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A server URL without trailing slashes, for comparing two servers. */
export function normaliseServer(server: string): string {
  return server.replace(/\/+$/, "");
}

/** The lego account id: the email, or `swamp` when there is none. */
export function accountId(email: string | undefined): string {
  return email ?? "swamp";
}

/**
 * The lego certificate name: `explicit`, or the first domain with `*` as
 * `_`, as lego names files. Refuses a name that is not a plain file name.
 */
export function certName(domains: string[], explicit?: string): string {
  const name = explicit ?? domains[0].replaceAll("*", "_");
  if (
    name === "" || name.startsWith(".") || name.includes("/") ||
    name.includes("\\") || name.includes("\0")
  ) {
    throw new Error(
      `certificate name ${JSON.stringify(name)} is not a plain file name`,
    );
  }
  return name;
}

/** The argv (after the binary) for `lego run`. */
export function runArgs(o: RunOptions): string[] {
  const args = [
    "run",
    "--path",
    o.path,
    "--server",
    o.server,
    "--accept-tos",
    "--account-id",
    o.accountId,
  ];
  if (o.email) args.push("--email", o.email);
  args.push("--key-type", o.keyType, "--cert.name", o.certName);
  for (const domain of o.domains) args.push("-d", domain);
  args.push("--dns", o.dnsProvider);
  if (o.dnsResolvers?.length) {
    args.push("--dns.resolvers", o.dnsResolvers.join(","));
  }
  if (o.dnsTimeout !== undefined) {
    args.push("--dns.timeout", String(o.dnsTimeout));
  }
  if (o.dnsPropagationWait) {
    args.push("--dns.propagation.wait", o.dnsPropagationWait);
  }
  if (o.dnsPropagationDisableAns) args.push("--dns.propagation.disable-ans");
  if (o.dnsPropagationDisableRns) args.push("--dns.propagation.disable-rns");
  if (o.profile) args.push("--profile", o.profile);
  if (o.preferredChain) args.push("--preferred-chain", o.preferredChain);
  if (o.renewDays !== undefined) {
    args.push("--renew-days", String(o.renewDays));
  }
  if (o.renewForce) args.push("--renew-force");
  if (o.eabKid) args.push("--eab", "--eab.kid", o.eabKid);
  args.push(
    "--force-cert-domains",
    "--no-random-sleep",
    "--log.format",
    "text",
  );
  return args;
}

/** The argv (after the binary) for `lego certificates revoke`. */
export function revokeArgs(o: RevokeOptions): string[] {
  const args = [
    "certificates",
    "revoke",
    "--path",
    o.path,
    "--server",
    o.server,
    "--account-id",
    o.accountId,
  ];
  if (o.email) args.push("--email", o.email);
  if (o.accountKeyType) args.push("--key-type", o.accountKeyType);
  args.push(
    "--cert.name",
    o.certName,
    "--keep",
    "--reason",
    String(o.reason),
    "--log.format",
    "text",
  );
  return args;
}

/**
 * The complete environment for a lego process (run it with `clearEnv`).
 * By default only an allowlist of the parent's variables is kept. With
 * `ambientCredentials` the parent passes through whole so credential chains
 * work, less any LEGO_* variable that would set a flag. DNS settings, the
 * EAB hmac and trace headers are laid over the top.
 */
export function childEnv(o: ChildEnvOptions): Record<string, string> {
  for (const name of Object.keys(o.dnsEnv)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(
        `DNS setting ${JSON.stringify(name)} is not an environment variable name`,
      );
    }
    if (name.startsWith("LEGO_")) {
      throw new Error(
        `DNS setting ${name} would set a lego option; set it through the ` +
          `behavior's global arguments instead`,
      );
    }
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(o.parentEnv)) {
    const keep = o.ambientCredentials
      ? !name.startsWith("LEGO_") || PARENT_LEGO_ALLOWED.has(name)
      : ALLOWED_PARENT_ENV.has(name);
    if (keep) env[name] = value;
  }
  Object.assign(env, o.dnsEnv);
  if (o.eabHmac) env.LEGO_EAB_HMAC = o.eabHmac;
  if (o.traceHeaders?.traceparent) {
    env.TRACEPARENT = o.traceHeaders.traceparent;
  }
  if (o.traceHeaders?.tracestate) env.TRACESTATE = o.traceHeaders.tracestate;
  return env;
}
