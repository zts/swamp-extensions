/**
 * Swamp vault provider backed by AWS Systems Manager Parameter Store.
 *
 * Every secret is a SecureString parameter named by the vault's
 * `parameter_prefix` followed by the secret key. Credentials come from the
 * AWS default chain, or from a named profile when `profile` is set.
 *
 * @module
 */

import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  type GetParameterCommandOutput,
  GetParametersByPathCommand,
  type GetParametersByPathCommandOutput,
  PutParameterCommand,
  type PutParameterCommandInput,
  SSMClient,
  type Tag,
} from "npm:@aws-sdk/client-ssm@3.1150.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1150.0";
import { z } from "npm:zod@4.6.7";

/** Options swamp passes to put. */
export interface VaultPutOptions {
  /** Tags to add to the parameter. */
  tags?: Record<string, string>;
}

/** The contract swamp holds a vault provider to. */
export interface VaultProvider {
  /** Fetches the current value of the given secret. */
  get(secretKey: string): Promise<string>;
  /** Writes a new value for the given secret, creating it if it does not exist. */
  put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void>;
  /** Lists all secret keys visible to the vault. */
  list(): Promise<string[]>;
  /** Returns the swamp-assigned name of this vault instance. */
  getName(): string;
}

/** The commands this provider sends to SSM. */
export type SsmCommand =
  | AddTagsToResourceCommand
  | DeleteParameterCommand
  | GetParameterCommand
  | GetParametersByPathCommand
  | PutParameterCommand;

/** The part of an SSM client the provider uses, so tests can supply one. */
export interface SsmSender {
  send(command: SsmCommand): Promise<unknown>;
  destroy?(): void;
}

/**
 * One path segment of a parameter name: the characters SSM allows in a
 * name, apart from the `/` that separates segments.
 */
const SEGMENT = "[A-Za-z0-9_.\\-]+";

/** A secret key: one or more segments joined by single `/`s. */
const KEY_PATTERN = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);

/**
 * Maps a secret key to its parameter name, refusing a key SSM would refuse
 * before any AWS call is made.
 */
export function parameterName(prefix: string, key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `invalid secret key ${JSON.stringify(key)}: use letters, digits, ` +
        "'_', '.', '-' and single '/' between segments, with no leading or " +
        "trailing '/'",
    );
  }
  return prefix + key;
}

const configSchema = z.object({
  region: z.string().min(1).describe("AWS region of the parameters"),
  profile: z.string().min(1).optional().describe(
    "Named AWS profile to use instead of the default credential chain",
  ),
  parameter_prefix: z.string().refine(
    (p) => p.startsWith("/") && p.endsWith("/"),
    "parameter_prefix must start and end with '/'",
  ).default("/swamp/").describe(
    "Prefix of every parameter name; a secret key is appended to it",
  ),
  kms_key_id: z.string().min(1).optional().describe(
    "KMS key for the parameters; alias/aws/ssm when omitted",
  ),
}).strict();

/** A vault's config, after validation and defaults. */
export type AwsSsmConfig = z.infer<typeof configSchema>;

const SECURE_STRING = "SecureString";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

/**
 * The AWS error name and message. `secret`, when given, is cut out of the
 * message: SSM validation messages can quote the value they refused.
 */
function describe(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[redacted]");
  return `${errorName(error)}: ${message}`;
}

/** An error that keeps the AWS error and the parameter name. */
function awsFailure(
  action: string,
  name: string,
  error: unknown,
  secret?: string,
): Error {
  return new Error(
    `aws-ssm ${action} ${name} failed: ${describe(error, secret)}`,
  );
}

function notSecure(action: string, name: string, type: string): Error {
  return new Error(
    `aws-ssm refuses to ${action} ${name}: ${name} is a ${type} parameter, ` +
      "not a SecureString",
  );
}

function toTags(tags: Record<string, string> | undefined): Tag[] {
  return Object.entries(tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
}

/** A swamp vault whose secrets are SecureString parameters under a prefix. */
export class AwsSsmVaultProvider implements VaultProvider {
  constructor(
    private readonly name: string,
    private readonly config: AwsSsmConfig,
    private readonly client: SsmSender,
  ) {}

  async get(secretKey: string): Promise<string> {
    const name = parameterName(this.config.parameter_prefix, secretKey);
    let output: GetParameterCommandOutput;
    try {
      output = await this.client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      ) as GetParameterCommandOutput;
    } catch (error) {
      if (errorName(error) === "ParameterNotFound") {
        throw new Error(`secret not found: ${secretKey} (parameter ${name})`);
      }
      throw awsFailure("get", name, error);
    }
    const type = output.Parameter?.Type ?? "untyped";
    if (type !== SECURE_STRING) throw notSecure("get", name, type);
    const value = output.Parameter?.Value;
    if (value === undefined) {
      throw new Error(`aws-ssm get ${name}: SSM returned no value for ${name}`);
    }
    return value;
  }

  async put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void> {
    const name = parameterName(this.config.parameter_prefix, secretKey);
    const type = await this.typeOf("put", name);
    if (type !== undefined && type !== SECURE_STRING) {
      throw notSecure("put", name, type);
    }
    const tags = toTags(options?.tags);
    const input: PutParameterCommandInput = {
      Name: name,
      Value: secretValue,
      Type: SECURE_STRING,
      // Sent explicitly, so an account whose default tier is Advanced or
      // Intelligent-Tiering still creates Standard parameters.
      Tier: "Standard",
      Overwrite: type !== undefined,
    };
    if (this.config.kms_key_id) input.KeyId = this.config.kms_key_id;

    if (type === undefined) {
      // A new parameter: Overwrite false, so a parameter someone else made
      // since the check is refused by SSM rather than overwritten, and the
      // tags go in the same call.
      if (tags.length > 0) input.Tags = tags;
      try {
        await this.client.send(new PutParameterCommand(input));
      } catch (error) {
        throw awsFailure("put", name, error, secretValue);
      }
      return;
    }

    // SSM refuses Tags together with Overwrite, so they follow the write.
    try {
      await this.client.send(new PutParameterCommand(input));
    } catch (error) {
      throw awsFailure("put", name, error, secretValue);
    }
    if (tags.length === 0) return;
    try {
      await this.client.send(
        new AddTagsToResourceCommand({
          ResourceType: "Parameter",
          ResourceId: name,
          Tags: tags,
        }),
      );
    } catch (error) {
      throw new Error(
        `aws-ssm put ${name}: the value was written but the tags were not: ` +
          describe(error, secretValue),
      );
    }
  }

  async list(): Promise<string[]> {
    const prefix = this.config.parameter_prefix;
    // The path keeps its trailing '/': IAM authorises GetParametersByPath
    // against the path itself, so /swamp would need parameter/swamp granted
    // on top of parameter/swamp/*, which covers /swamp/.
    const path = prefix;
    const keys: string[] = [];
    let nextToken: string | undefined;
    do {
      let output: GetParametersByPathCommandOutput;
      try {
        output = await this.client.send(
          new GetParametersByPathCommand({
            Path: path,
            Recursive: true,
            WithDecryption: false,
            ParameterFilters: [
              { Key: "Type", Option: "Equals", Values: [SECURE_STRING] },
            ],
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        ) as GetParametersByPathCommandOutput;
      } catch (error) {
        throw awsFailure("list", path, error);
      }
      for (const parameter of output.Parameters ?? []) {
        const name = parameter.Name;
        if (name?.startsWith(prefix) && name.length > prefix.length) {
          keys.push(name.slice(prefix.length));
        }
      }
      nextToken = output.NextToken;
    } while (nextToken);
    return keys;
  }

  /**
   * Deletes a secret at once; SSM keeps no recovery window. Deleting a key
   * that does not exist succeeds.
   */
  async delete(secretKey: string): Promise<void> {
    const name = parameterName(this.config.parameter_prefix, secretKey);
    const type = await this.typeOf("delete", name);
    if (type === undefined) return;
    if (type !== SECURE_STRING) throw notSecure("delete", name, type);
    try {
      await this.client.send(new DeleteParameterCommand({ Name: name }));
    } catch (error) {
      if (errorName(error) === "ParameterNotFound") return;
      throw awsFailure("delete", name, error);
    }
  }

  getName(): string {
    return this.name;
  }

  /** Closes the SDK client and its connections. */
  destroy(): void {
    this.client.destroy?.();
  }

  /**
   * The type of a parameter, read without decrypting it, or undefined when
   * it does not exist.
   */
  private async typeOf(
    action: string,
    name: string,
  ): Promise<string | undefined> {
    try {
      const output = await this.client.send(
        new GetParameterCommand({ Name: name, WithDecryption: false }),
      ) as GetParameterCommandOutput;
      return output.Parameter?.Type ?? "untyped";
    } catch (error) {
      if (errorName(error) === "ParameterNotFound") return undefined;
      throw awsFailure(action, name, error);
    }
  }
}

/** The vault type swamp loads from this extension. */
export const vault = {
  type: "@zts/aws-ssm",
  name: "AWS SSM Parameter Store",
  description:
    "Stores swamp secrets as SecureString parameters in AWS Systems Manager " +
    "Parameter Store, under a prefix, on the Standard tier.",
  configSchema,
  createProvider(
    name: string,
    config: Record<string, unknown>,
  ): AwsSsmVaultProvider {
    const parsed = configSchema.parse(config);
    const client = new SSMClient({
      region: parsed.region,
      ...(parsed.profile
        ? { credentials: fromIni({ profile: parsed.profile }) }
        : {}),
    });
    return new AwsSsmVaultProvider(name, parsed, client);
  },
};
