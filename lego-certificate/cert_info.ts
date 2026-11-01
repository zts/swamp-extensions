/**
 * Reads the facts swamp records about a certificate from the PEM bundle
 * lego writes, so they come from the certificate and not the arguments.
 *
 * @module
 */
import { X509Certificate } from "node:crypto";

/** What swamp records about an issued certificate. */
export interface CertificateInfo {
  /** DNS names from the subjectAltName extension, in certificate order. */
  domains: string[];
  /** Serial number, upper-case hex in whole bytes. */
  serial: string;
  notBefore: string;
  notAfter: string;
  issuer: string;
  /** SHA-256 of the leaf's DER, lower-case hex without separators. */
  fingerprintSha256: string;
  /** The leaf certificate alone. */
  leafPem: string;
  /** The rest of the bundle (intermediates), or "" when lego wrote none. */
  chainPem: string;
}

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----\r?\n[\s\S]*?-----END CERTIFICATE-----\r?\n?/g;

/** Parse lego's `<name>.crt`: the leaf first, then any chain. */
export function parseBundle(bundle: string): CertificateInfo {
  const blocks = bundle.match(PEM_BLOCK);
  if (!blocks) throw new Error("lego's certificate file holds no certificate");
  const [leafPem, ...chain] = blocks.map((b) =>
    b.endsWith("\n") ? b : `${b}\n`
  );
  const leaf = new X509Certificate(leafPem);
  const domains = (leaf.subjectAltName ?? "").split(", ")
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length));
  return {
    domains,
    // node:crypto drops a leading zero nibble; pad to whole bytes, as
    // openssl and browsers show it.
    serial: leaf.serialNumber.toUpperCase().padStart(
      Math.ceil(leaf.serialNumber.length / 2) * 2,
      "0",
    ),
    notBefore: new Date(leaf.validFrom).toISOString(),
    notAfter: new Date(leaf.validTo).toISOString(),
    issuer: leaf.issuer.replaceAll("\n", ", "),
    fingerprintSha256: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
    leafPem,
    chainPem: chain.join(""),
  };
}

/** Whole days from `now` until `notAfter`, rounded down. */
export function daysRemaining(notAfter: string, now: Date): number {
  return Math.floor(
    (new Date(notAfter).getTime() - now.getTime()) / 86_400_000,
  );
}
