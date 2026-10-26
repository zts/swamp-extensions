import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from "npm:@aws-sdk/client-ssm@3.1150.0";
import {
  AwsSsmVaultProvider,
  parameterName,
  type SsmSender,
  vault,
} from "./aws_ssm.ts";

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
    const result = vault.configSchema.safeParse({
      ...CONFIG,
      parameter_prefix,
    });
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

// The provider, against a fake SSM client.

type Call = { command: string; input: Record<string, unknown> };
type Handler = (command: string, input: Record<string, unknown>) => unknown;

const COMMANDS: [string, abstract new (...args: never[]) => unknown][] = [
  ["GetParameter", GetParameterCommand],
  ["PutParameter", PutParameterCommand],
  ["GetParametersByPath", GetParametersByPathCommand],
  ["DeleteParameter", DeleteParameterCommand],
  ["AddTagsToResource", AddTagsToResourceCommand],
];

/** An SSM client that records every command and answers from `handler`. */
function fakeClient(handler: Handler) {
  const calls: Call[] = [];
  let destroyed = false;
  const client: SsmSender = {
    send(command) {
      const entry = COMMANDS.find(([, type]) => command instanceof type);
      if (!entry) throw new Error("unexpected command");
      const input =
        (command as unknown as { input: Record<string, unknown> }).input;
      calls.push({ command: entry[0], input });
      try {
        return Promise.resolve(handler(entry[0], input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    destroy() {
      destroyed = true;
    },
  };
  return { client, calls, isDestroyed: () => destroyed };
}

function awsError(name: string, message = `${name} raised`): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function build(handler: Handler, config: Record<string, unknown> = {}) {
  const fake = fakeClient(handler);
  const parsed = vault.configSchema.parse({ ...CONFIG, ...config });
  const provider = new AwsSsmVaultProvider("ssm", parsed, fake.client);
  return { provider, ...fake };
}

const SECRET = "hunter2-secret-value";
const NAME = "/swamp/db/password";

/** Answers the type check put and delete make, then defers to `rest`. */
function existing(type: string | null, rest: Handler = () => ({})): Handler {
  return (command, input) => {
    if (command === "GetParameter" && input.WithDecryption === false) {
      if (type === null) throw awsError("ParameterNotFound");
      return { Parameter: { Name: input.Name, Type: type, Value: "ignored" } };
    }
    return rest(command, input);
  };
}

Deno.test("get returns the decrypted value", async () => {
  const { provider, calls } = build(() => ({
    Parameter: { Name: NAME, Type: "SecureString", Value: SECRET },
  }));

  assertEquals(await provider.get("db/password"), SECRET);
  assertEquals(calls, [{
    command: "GetParameter",
    input: { Name: NAME, WithDecryption: true },
  }]);
});

Deno.test("get of a missing key is a not-found error naming it", async () => {
  const { provider } = build(() => {
    throw awsError("ParameterNotFound");
  });

  const error = await assertRejects(() => provider.get("db/password"));
  assertStringIncludes(String(error), "secret not found: db/password");
  assertStringIncludes(String(error), NAME);
});

Deno.test("get refuses a parameter that is not a SecureString", async () => {
  for (const type of ["String", "StringList"]) {
    const { provider } = build(() => ({
      Parameter: { Name: NAME, Type: type, Value: SECRET },
    }));

    const error = await assertRejects(() => provider.get("db/password"));
    assertStringIncludes(String(error), `${NAME} is a ${type} parameter`);
    assert(!String(error).includes(SECRET));
  }
});

Deno.test("get refuses an answer with no value", async () => {
  const { provider } = build(() => ({
    Parameter: { Name: NAME, Type: "SecureString" },
  }));

  await assertRejects(
    () => provider.get("db/password"),
    Error,
    `SSM returned no value for ${NAME}`,
  );
});

Deno.test("get keeps the AWS error name and the parameter name", async () => {
  const { provider } = build(() => {
    throw awsError("AccessDeniedException", "not allowed to ssm:GetParameter");
  });

  const error = await assertRejects(() => provider.get("db/password"));
  assertStringIncludes(String(error), "AccessDeniedException");
  assertStringIncludes(String(error), "not allowed to ssm:GetParameter");
  assertStringIncludes(String(error), NAME);
});

Deno.test("an invalid key is refused before any call", async () => {
  const { provider, calls } = build(() => ({}));

  await assertRejects(() => provider.get("/db"), Error, "invalid secret key");
  await assertRejects(
    () => provider.put("db//x", SECRET),
    Error,
    "invalid secret key",
  );
  await assertRejects(() => provider.delete(""), Error, "invalid secret key");
  assertEquals(calls, []);
});

Deno.test("put overwrites an existing SecureString on the Standard tier", async () => {
  const { provider, calls } = build(existing("SecureString"), {
    kms_key_id: "alias/swamp",
  });

  await provider.put("db/password", SECRET);
  assertEquals(calls, [
    { command: "GetParameter", input: { Name: NAME, WithDecryption: false } },
    {
      command: "PutParameter",
      input: {
        Name: NAME,
        Value: SECRET,
        Type: "SecureString",
        Tier: "Standard",
        Overwrite: true,
        KeyId: "alias/swamp",
      },
    },
  ]);
});

Deno.test("put tags an existing parameter after the write", async () => {
  const { provider, calls } = build(existing("SecureString"));

  await provider.put("db/password", SECRET, { tags: { team: "core" } });
  assertEquals(calls.map((c) => c.command), [
    "GetParameter",
    "PutParameter",
    "AddTagsToResource",
  ]);
  assertEquals(calls[1].input.Tags, undefined);
  assertEquals(calls[1].input.KeyId, undefined);
  assertEquals(calls[2].input, {
    ResourceType: "Parameter",
    ResourceId: NAME,
    Tags: [{ Key: "team", Value: "core" }],
  });
});

Deno.test("put creates a missing parameter with its tags in one call", async () => {
  const { provider, calls } = build(existing(null));

  await provider.put("db/password", SECRET, { tags: { team: "core" } });
  assertEquals(calls.map((c) => c.command), ["GetParameter", "PutParameter"]);
  assertEquals(calls[1].input, {
    Name: NAME,
    Value: SECRET,
    Type: "SecureString",
    Tier: "Standard",
    Overwrite: false,
    Tags: [{ Key: "team", Value: "core" }],
  });
});

Deno.test("put creates a missing parameter without tags", async () => {
  const { provider, calls } = build(existing(null));

  await provider.put("db/password", SECRET);
  assertEquals(calls[1].input.Overwrite, false);
  assertEquals("Tags" in calls[1].input, false);
});

Deno.test("put does not overwrite a parameter created after its check", async () => {
  const { provider, calls } = build(existing(null, () => {
    throw awsError("ParameterAlreadyExists");
  }));

  const error = await assertRejects(() => provider.put("db/password", SECRET));
  assertStringIncludes(String(error), "ParameterAlreadyExists");
  assertStringIncludes(String(error), NAME);
  assertEquals(calls.map((c) => c.command), ["GetParameter", "PutParameter"]);
});

Deno.test("put refuses a String or StringList parameter and writes nothing", async () => {
  for (const type of ["String", "StringList"]) {
    const { provider, calls } = build(existing(type));

    const error = await assertRejects(() =>
      provider.put("db/password", SECRET)
    );
    assertStringIncludes(String(error), `${NAME} is a ${type} parameter`);
    assertEquals(calls.map((c) => c.command), ["GetParameter"]);
  }
});

Deno.test("put reports a value written whose tags were not", async () => {
  const { provider } = build(existing("SecureString", (command) => {
    if (command === "AddTagsToResource") {
      throw awsError("AccessDeniedException");
    }
    return {};
  }));

  const error = await assertRejects(() =>
    provider.put("db/password", SECRET, { tags: { team: "core" } })
  );
  assertStringIncludes(String(error), "value was written");
  assertStringIncludes(String(error), "tags were not");
  assertStringIncludes(String(error), "AccessDeniedException");
  assert(!String(error).includes(SECRET));
});

Deno.test("put never puts the value in an error or a log line", async () => {
  const logged: string[] = [];
  const saved = { ...console };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => logged.push(args.join(" "));
  }
  try {
    const { provider } = build(existing("SecureString", () => {
      throw awsError(
        "ValidationException",
        `Value '${SECRET}' at 'value' failed to satisfy constraint`,
      );
    }));

    const error = await assertRejects(() =>
      provider.put("db/password", SECRET)
    );
    assertStringIncludes(String(error), "ValidationException");
    assert(!String(error).includes(SECRET), String(error));
  } finally {
    Object.assign(console, saved);
  }
  assert(!logged.some((line) => line.includes(SECRET)));
});

Deno.test("list follows every page and strips the prefix", async () => {
  const { provider, calls } = build((_command, input) =>
    input.NextToken === undefined
      ? {
        Parameters: [{ Name: "/swamp/a" }, { Name: "/swamp/db/b" }],
        NextToken: "page-2",
      }
      : { Parameters: [{ Name: "/swamp/c" }] }
  );

  assertEquals(await provider.list(), ["a", "db/b", "c"]);
  const query = {
    Path: "/swamp",
    Recursive: true,
    WithDecryption: false,
    ParameterFilters: [
      { Key: "Type", Option: "Equals", Values: ["SecureString"] },
    ],
  };
  assertEquals(calls, [
    { command: "GetParametersByPath", input: query },
    {
      command: "GetParametersByPath",
      input: { ...query, NextToken: "page-2" },
    },
  ]);
});

Deno.test("list under the / prefix asks for the root path", async () => {
  const { provider, calls } = build(() => ({
    Parameters: [{ Name: "/a" }, { Name: "/b/c" }],
  }), { parameter_prefix: "/" });

  assertEquals(await provider.list(), ["a", "b/c"]);
  assertEquals(calls[0].input.Path, "/");
});

Deno.test("list leaves out names outside the prefix", async () => {
  const { provider } = build(() => ({
    Parameters: [{ Name: "/swamp/a" }, { Name: "/swampy/b" }, {}],
  }));

  assertEquals(await provider.list(), ["a"]);
});

Deno.test("delete removes a SecureString parameter", async () => {
  const { provider, calls } = build(existing("SecureString"));

  await provider.delete("db/password");
  assertEquals(calls, [
    { command: "GetParameter", input: { Name: NAME, WithDecryption: false } },
    { command: "DeleteParameter", input: { Name: NAME } },
  ]);
});

Deno.test("delete of a missing key succeeds", async () => {
  const { provider, calls } = build(existing(null));

  await provider.delete("db/password");
  assertEquals(calls.map((c) => c.command), ["GetParameter"]);
});

Deno.test("delete of a key removed after its check succeeds", async () => {
  const { provider } = build(existing("SecureString", () => {
    throw awsError("ParameterNotFound");
  }));

  await provider.delete("db/password");
});

Deno.test("delete refuses a String or StringList parameter", async () => {
  for (const type of ["String", "StringList"]) {
    const { provider, calls } = build(existing(type));

    const error = await assertRejects(() => provider.delete("db/password"));
    assertStringIncludes(String(error), `${NAME} is a ${type} parameter`);
    assertEquals(calls.map((c) => c.command), ["GetParameter"]);
  }
});

Deno.test("getName returns the vault name", () => {
  assertEquals(build(() => ({})).provider.getName(), "ssm");
});

Deno.test("destroy closes the client", () => {
  const { provider, isDestroyed } = build(() => ({}));

  provider.destroy();
  assert(isDestroyed());
});
