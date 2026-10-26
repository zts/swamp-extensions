import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  assertVaultConformance,
  assertVaultExportConformance,
} from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { vault } from "./aws_ssm.ts";

const REGION = "eu-west-1";

Deno.test("vault export conforms", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [
      { region: REGION },
      {
        region: REGION,
        profile: "dev",
        parameter_prefix: "/team/",
        kms_key_id: "alias/swamp",
      },
    ],
    invalidConfigs: [
      {},
      { region: "" },
      { region: REGION, parameter_prefix: "swamp" },
      { region: REGION, kmsKeyId: "alias/swamp" },
    ],
  });
});

type Parameter = {
  Name: string;
  Type: string;
  Value: string;
  Tags: Record<string, string>;
};

/**
 * A local SSM endpoint speaking the JSON protocol over an in-memory store,
 * so the real SDK client is used for signing, serialisation and errors.
 */
function startMockSsm() {
  const parameters = new Map<string, Parameter>();
  const accessKeys: string[] = [];
  const fail = (type: string) =>
    Response.json({ __type: type, message: `${type} (mock)` }, {
      status: 400,
      headers: { "content-type": "application/x-amz-json-1.1" },
    });
  const ok = (body: unknown) =>
    Response.json(body, {
      headers: { "content-type": "application/x-amz-json-1.1" },
    });

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const auth = req.headers.get("authorization") ?? "";
      accessKeys.push(/Credential=([^/]+)\//.exec(auth)?.[1] ?? "");
      const action = (req.headers.get("x-amz-target") ?? "").replace(
        "AmazonSSM.",
        "",
      );
      const body = await req.json();
      const tags = (list?: { Key: string; Value: string }[]) =>
        Object.fromEntries((list ?? []).map((t) => [t.Key, t.Value]));

      switch (action) {
        case "GetParameter": {
          const p = parameters.get(body.Name);
          if (!p) return fail("ParameterNotFound");
          const Value = p.Type === "SecureString" && !body.WithDecryption
            ? "encrypted-blob"
            : p.Value;
          return ok({ Parameter: { Name: p.Name, Type: p.Type, Value } });
        }
        case "PutParameter": {
          const current = parameters.get(body.Name);
          if (current && !body.Overwrite) return fail("ParameterAlreadyExists");
          if (body.Tags && body.Overwrite) return fail("ValidationException");
          parameters.set(body.Name, {
            Name: body.Name,
            Type: body.Type,
            Value: body.Value,
            Tags: current?.Tags ?? tags(body.Tags),
          });
          return ok({ Version: 1, Tier: body.Tier });
        }
        case "AddTagsToResource": {
          const p = parameters.get(body.ResourceId);
          if (!p) return fail("InvalidResourceId");
          Object.assign(p.Tags, tags(body.Tags));
          return ok({});
        }
        case "GetParametersByPath": {
          const path = body.Path.endsWith("/") ? body.Path : `${body.Path}/`;
          const type = body.ParameterFilters?.[0]?.Values?.[0];
          const Parameters = [...parameters.values()]
            .filter((p) => p.Name.startsWith(path))
            .filter((p) => !type || p.Type === type)
            .map((p) => ({ Name: p.Name, Type: p.Type }));
          return ok({ Parameters });
        }
        case "DeleteParameter": {
          if (!parameters.delete(body.Name)) return fail("ParameterNotFound");
          return ok({});
        }
        default:
          return fail("InvalidAction");
      }
    },
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    parameters,
    accessKeys,
    endpoint: `http://127.0.0.1:${port}`,
    shutdown: () => server.shutdown(),
  };
}

/**
 * Runs `fn` with every AWS_* variable cleared, then `env` set, and the AWS
 * config and credentials files pointed at temporary files holding `config`
 * and `credentials`, so the developer's own AWS setup never leaks in. The
 * environment is restored afterwards.
 */
async function withAwsEnv(
  env: Record<string, string>,
  files: { config?: string; credentials?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.entries(Deno.env.toObject())
    .filter(([key]) => key.startsWith("AWS_"));
  const dir = await Deno.makeTempDir({ prefix: "aws-ssm-test-" });
  try {
    for (const [key] of saved) Deno.env.delete(key);
    const configFile = `${dir}/config`;
    const credentialsFile = `${dir}/credentials`;
    await Deno.writeTextFile(configFile, files.config ?? "");
    await Deno.writeTextFile(credentialsFile, files.credentials ?? "");
    Deno.env.set("AWS_CONFIG_FILE", configFile);
    Deno.env.set("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
    await fn();
  } finally {
    for (const key of Object.keys(Deno.env.toObject())) {
      if (key.startsWith("AWS_")) Deno.env.delete(key);
    }
    for (const [key, value] of saved) Deno.env.set(key, value);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the real SDK client conforms against a mock SSM endpoint", async () => {
  const ssm = startMockSsm();
  try {
    await withAwsEnv(
      {
        AWS_ENDPOINT_URL: ssm.endpoint,
        AWS_ACCESS_KEY_ID: "AKIAENVIRONMENT",
        AWS_SECRET_ACCESS_KEY: "env-secret",
      },
      {},
      async () => {
        const provider = vault.createProvider("conformance", {
          region: REGION,
        });
        try {
          await assertVaultConformance(provider, {
            testTags: true,
            getStoredTags: (key) => {
              const tags = ssm.parameters.get(`/swamp/${key}`)?.Tags;
              return tags && Object.keys(tags).length > 0 ? tags : undefined;
            },
          });

          await provider.put("db/password", "first", { tags: { a: "1" } });
          await provider.put("db/password", "second", { tags: { b: "2" } });
          assertEquals(await provider.get("db/password"), "second");
          assertEquals(ssm.parameters.get("/swamp/db/password")?.Tags, {
            a: "1",
            b: "2",
          });

          await provider.delete("db/password");
          await provider.delete("db/password");
          assert(!(await provider.list()).includes("db/password"));

          const missing = await provider.get("db/password").catch((e) => e);
          assertStringIncludes(
            String(missing),
            "secret not found: db/password",
          );
        } finally {
          provider.destroy();
        }
      },
    );
    assert(ssm.accessKeys.length > 0);
    assert(ssm.accessKeys.every((key) => key === "AKIAENVIRONMENT"));
  } finally {
    await ssm.shutdown();
  }
});

Deno.test("the SDK client refuses to touch a String parameter", async () => {
  const ssm = startMockSsm();
  ssm.parameters.set("/swamp/plain", {
    Name: "/swamp/plain",
    Type: "String",
    Value: "owned-elsewhere",
    Tags: {},
  });
  try {
    await withAwsEnv(
      {
        AWS_ENDPOINT_URL: ssm.endpoint,
        AWS_ACCESS_KEY_ID: "AKIAENVIRONMENT",
        AWS_SECRET_ACCESS_KEY: "env-secret",
      },
      {},
      async () => {
        const provider = vault.createProvider("plain", { region: REGION });
        try {
          for (
            const attempt of [
              () => provider.get("plain"),
              () => provider.put("plain", "new"),
              () => provider.delete("plain"),
            ]
          ) {
            const error = await attempt().catch((e) => e);
            assertStringIncludes(String(error), "is a String parameter");
          }
          assertEquals(await provider.list(), []);
        } finally {
          provider.destroy();
        }
      },
    );
    assertEquals(ssm.parameters.get("/swamp/plain")?.Value, "owned-elsewhere");
  } finally {
    await ssm.shutdown();
  }
});

Deno.test("a profile's credentials win over the environment's", async () => {
  const ssm = startMockSsm();
  try {
    await withAwsEnv({
      AWS_ENDPOINT_URL: ssm.endpoint,
      AWS_ACCESS_KEY_ID: "AKIAENVIRONMENT",
      AWS_SECRET_ACCESS_KEY: "env-secret",
    }, {
      credentials: [
        "[swamp-test]",
        "aws_access_key_id = AKIAPROFILE",
        "aws_secret_access_key = profile-secret",
        "",
      ].join("\n"),
    }, async () => {
      const provider = vault.createProvider("profile", {
        region: REGION,
        profile: "swamp-test",
      });
      try {
        await provider.put("k", "v");
        assertEquals(await provider.get("k"), "v");
      } finally {
        provider.destroy();
      }
    });
    assert(ssm.accessKeys.length > 0);
    assert(ssm.accessKeys.every((key) => key === "AKIAPROFILE"));
  } finally {
    await ssm.shutdown();
  }
});
