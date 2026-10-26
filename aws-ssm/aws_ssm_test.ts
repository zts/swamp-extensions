import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { parameterName, vault } from "./aws_ssm.ts";

const CONFIG = { region: "eu-west-1" };

Deno.test("config defaults the prefix to /swamp/", () => {
  const parsed = vault.configSchema.parse(CONFIG);
  assertEquals(parsed.parameter_prefix, "/swamp/");
});

Deno.test("config accepts every documented key", () => {
  const config = {
    region: "eu-west-1",
    profile: "dev",
    parameter_prefix: "/team/app/",
    kms_key_id: "alias/swamp",
  };
  assertEquals(vault.configSchema.parse(config), config);
});

Deno.test("config requires a region", () => {
  assertEquals(vault.configSchema.safeParse({}).success, false);
  assertEquals(vault.configSchema.safeParse({ region: "" }).success, false);
});

Deno.test("config refuses a prefix without a leading or trailing /", () => {
  for (const parameter_prefix of ["swamp/", "/swamp", "swamp", ""]) {
    const result = vault.configSchema.safeParse({ ...CONFIG, parameter_prefix });
    assertEquals(result.success, false, parameter_prefix);
  }
});

Deno.test("config accepts / as the prefix", () => {
  const parsed = vault.configSchema.parse({ ...CONFIG, parameter_prefix: "/" });
  assertEquals(parsed.parameter_prefix, "/");
});

Deno.test("config refuses unknown keys", () => {
  for (const extra of [{ kmsKeyId: "alias/swamp" }, { prefix: "/x/" }]) {
    const result = vault.configSchema.safeParse({ ...CONFIG, ...extra });
    assertEquals(result.success, false, JSON.stringify(extra));
  }
});

Deno.test("a key maps to the prefix plus the key", () => {
  assertEquals(parameterName("/swamp/", "db/password"), "/swamp/db/password");
  assertEquals(parameterName("/", "api-key"), "/api-key");
  assertEquals(parameterName("/a/b/", "x_y.z-1"), "/a/b/x_y.z-1");
});

Deno.test("a key SSM would refuse is rejected", () => {
  for (
    const key of ["", "/db", "db/", "db//password", "db password", "db:x", "é"]
  ) {
    assertThrows(
      () => parameterName("/swamp/", key),
      Error,
      "invalid secret key",
      JSON.stringify(key),
    );
  }
});
