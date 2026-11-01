import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { daysRemaining, parseBundle } from "./cert_info.ts";
import { ISSUER, PAIR_1, WILDCARD } from "./testdata/certificates.ts";

Deno.test("parseBundle reads the leaf's facts and splits off the chain", () => {
  const info = parseBundle(PAIR_1 + ISSUER);
  assertEquals(info.domains, ["example.com", "www.example.com"]);
  assertEquals(info.serial, "01");
  assertEquals(info.issuer, "CN=Fixture Test CA");
  assertEquals(info.leafPem, PAIR_1);
  assertEquals(info.chainPem, ISSUER);
  assertEquals(info.fingerprintSha256.length, 64);
  assertEquals(info.fingerprintSha256, info.fingerprintSha256.toLowerCase());
  assertEquals(
    new Date(info.notAfter).getTime() - new Date(info.notBefore).getTime(),
    3650 * 86_400_000,
  );
});

Deno.test("parseBundle keeps wildcard names as written", () => {
  assertEquals(parseBundle(WILDCARD).domains, ["*.example.com", "example.com"]);
  assertEquals(parseBundle(WILDCARD).chainPem, "");
});

Deno.test("parseBundle refuses text with no certificate", () => {
  assertThrows(() => parseBundle("not a certificate"), Error, "no certificate");
});

Deno.test("parseBundle refuses a corrupt certificate", () => {
  const corrupt = PAIR_1.replace(/[A-Za-z]{8}/, "AAAAAAAA");
  assertThrows(() => parseBundle(corrupt), Error);
});

Deno.test("daysRemaining rounds down and goes negative once expired", () => {
  const notAfter = "2026-11-11T12:00:00.000Z";
  assertEquals(daysRemaining(notAfter, new Date("2026-11-01T13:00:00Z")), 9);
  assertEquals(daysRemaining(notAfter, new Date("2026-11-01T12:00:00Z")), 10);
  assertEquals(daysRemaining(notAfter, new Date("2026-11-12T12:00:00Z")), -1);
});
