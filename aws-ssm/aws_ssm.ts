/**
 * Swamp vault provider backed by AWS Systems Manager Parameter Store.
 *
 * Every secret is a SecureString parameter named by the vault's
 * `parameter_prefix` followed by the secret key. Credentials come from the
 * AWS default chain, or from a named profile when `profile` is set.
 *
 * @module
 */

import { z } from "npm:zod@4.6.7";

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
    "Named profile from the AWS config files. When set it is used instead " +
      "of the default credential chain.",
  ),
  parameter_prefix: z.string().refine(
    (p) => p.startsWith("/") && p.endsWith("/"),
    "parameter_prefix must start and end with '/'",
  ).default("/swamp/").describe(
    "Prefix of every parameter name; a secret key is appended to it",
  ),
  kms_key_id: z.string().min(1).optional().describe(
    "KMS key that encrypts the parameters. The AWS-managed alias/aws/ssm " +
      "key when omitted.",
  ),
}).strict();

export const vault = {
  configSchema,
};
