# @zts/aws-ssm

A swamp vault on [AWS Systems Manager Parameter Store][ssm]. Every secret is a
`SecureString` parameter, encrypted with KMS, named by the vault's prefix
followed by the secret key. Standard parameters cost nothing, so it suits small
sets of secrets that do not need Secrets Manager's rotation.

[ssm]: https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html

## Usage

```sh
swamp extension pull @zts/aws-ssm
# choose a prefix and give the vault's credentials a policy for it first:
# see "Setting up a vault"
swamp vault create @zts/aws-ssm ssm \
  --config '{"region": "eu-west-1", "parameter_prefix": "/swamp/ssm/"}'

# put reads the value from stdin, or prompts for it without echo
printf '%s' "$DB_PASSWORD" | swamp vault put ssm db/password
swamp vault put ssm api-key

swamp vault read-secret ssm db/password
swamp vault list-keys ssm
swamp vault delete ssm db/password
```

Never pass a secret as an argument: it lands in shell history and is visible to
other processes.

## Configuration

| Key                | Required | Default   | Meaning                                                                          |
| ------------------ | -------- | --------- | -------------------------------------------------------------------------------- |
| `region`           | yes      |           | AWS region of the parameters                                                     |
| `profile`          | no       |           | Named profile from `~/.aws/config`; used instead of the default credential chain |
| `parameter_prefix` | no       | `/swamp/` | Prefix of every parameter name; must start and end with `/`                      |
| `kms_key_id`       | no       |           | KMS key id, ARN or alias; the AWS-managed `alias/aws/ssm` key when omitted       |

Unknown keys are refused when the vault is created, so a misspelling such as
`kmsKeyId` cannot quietly leave secrets on the default key.

Every put encrypts with the vault's key. Without `kms_key_id`, overwriting a
parameter that was created elsewhere with a customer-managed key re-encrypts it
under `alias/aws/ssm`. Set `kms_key_id` to that key to keep such parameters on
it.

## Authentication

With no `profile`, the AWS SDK's default credential chain is used: environment
variables, the shared config and credentials files (and `AWS_PROFILE`), SSO, web
identity, and container or instance roles. With `profile` set, that profile's
credentials are used even when credentials are also in the environment.
Credentials never appear in the vault's config or in swamp data.

## Setting up a vault

Each vault owns one prefix, and its credentials can reach nothing outside it.
Several vaults can share a region, an account and a KMS key and stay separate.
Set one up in three steps, in this order.

### 1. Choose the prefix

Pick a `parameter_prefix` for this vault alone, such as `/swamp/payments/`. It
must start and end with `/`. It must not contain another vault's prefix, or sit
inside one: under `/swamp/` the key `payments/db` is the parameter
`/swamp/payments/db`, which a vault on `/swamp/payments/` also sees as its key
`db`, and a policy for `/swamp/*` covers both. The same goes for parameters
other systems write: give the vault a prefix nothing else uses. Set the prefix
even for a single vault, rather than relying on the default `/swamp/`, so a
second vault later cannot land on the first one's prefix.

### 2. Create the IAM policy

Create a policy for the prefix and attach it to the role or user whose
credentials the vault will use (see [Authentication](#authentication)), and give
those credentials nothing else under any other vault's prefix. In the policies
below, `<prefix>` is the vault's `parameter_prefix` written directly after
`parameter`: `/swamp/payments/` gives
`arn:aws:ssm:<region>:<account>:parameter/swamp/payments/*`.

Every action is granted on the parameters under the prefix and nothing else:

- `ssm:GetParameter`: get, and the type check before put and delete, which reads
  without decrypting
- `ssm:PutParameter`: put
- `ssm:AddTagsToResource`: put with tags (`swamp vault put --label key=value`),
  both when creating a key and when tagging one that exists
- `ssm:DeleteParameter`: delete
- `ssm:GetParametersByPath`: list-keys, and put, since `swamp vault put` lists
  the vault's keys first

Both policies were tested on 2026-10-27: every operation above, under a role
holding only that policy.

#### With the default key

Without `kms_key_id`, parameters use the AWS-managed `alias/aws/ssm` key, which
SSM uses on the caller's behalf. No KMS statement is needed: the SSM statement
alone keeps the vault to its prefix.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SwampVaultParameters",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:PutParameter",
        "ssm:AddTagsToResource",
        "ssm:DeleteParameter",
        "ssm:GetParametersByPath"
      ],
      "Resource": "arn:aws:ssm:<region>:<account>:parameter<prefix>*"
    }
  ]
}
```

#### With a customer-managed key

With `kms_key_id`, add `kms:Encrypt` (put) and `kms:Decrypt` (get) on that key.
The resource is the key's ARN even when `kms_key_id` is an alias: KMS checks the
key the alias points to. The `kms:ViaService` condition limits the statement to
calls SSM makes for the caller, and the `kms:EncryptionContext:PARAMETER_ARN`
condition to parameters under the prefix, so the key can be shared with other
vaults, or other systems, without this one decrypting their parameters even if
its credentials gain wider SSM rights. This assumes the key's policy leaves
access to IAM, as a key's default policy does; a key policy that does not must
grant the role itself.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SwampVaultParameters",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:PutParameter",
        "ssm:AddTagsToResource",
        "ssm:DeleteParameter",
        "ssm:GetParametersByPath"
      ],
      "Resource": "arn:aws:ssm:<region>:<account>:parameter<prefix>*"
    },
    {
      "Sid": "SwampVaultKey",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<key-id>",
      "Condition": {
        "StringEquals": { "kms:ViaService": "ssm.<region>.amazonaws.com" },
        "StringLike": {
          "kms:EncryptionContext:PARAMETER_ARN": "arn:aws:ssm:<region>:<account>:parameter<prefix>*"
        }
      }
    }
  ]
}
```

For the prefix `/`, the resources are `parameter/*`, which covers every
parameter in the region; that case was not tested, and such a vault cannot be
kept apart from any other. Versions before 2026.10.27.1 sent list-keys' path
without its trailing `/`, so they also needed the prefix without that `/`
(`parameter/swamp` for `/swamp/`) for `ssm:GetParametersByPath`.

### 3. Create the vault

Create the vault with the prefix from step 1, using the credentials that hold
the policy from step 2 (the `profile` key, or the default credential chain):

```sh
swamp vault create @zts/aws-ssm payments --config '{
  "region": "eu-west-1",
  "profile": "payments-vault",
  "parameter_prefix": "/swamp/payments/"
}'
```

Add `"kms_key_id"` for a customer-managed key. Then run
`swamp vault list-keys payments`: an AccessDenied names the action and the
resource the policy is missing.

## Keys and parameter names

A key is one or more segments of letters, digits, `_`, `.` and `-`, joined by
single `/`s. The key `db/password` under the prefix `/swamp/` is the parameter
`/swamp/db/password`. Other keys are refused before any AWS call. SSM's own
limits still apply to the full name (at most 15 levels and 1011 characters, and
no first segment starting with `aws` or `ssm`); a name past them is refused with
SSM's error.

## Behaviour

- **SecureString only.** get, put and delete refuse a `String` or `StringList`
  parameter and name it, so a plaintext parameter owned by another system is
  never handed out, overwritten or deleted. list-keys shows only `SecureString`
  parameters. put and delete check the type and then write in two calls, so a
  parameter another system creates between them is not caught: give the vault a
  prefix of its own.
- **Standard tier only.** Every write asks for the Standard tier, whatever the
  account's default tier. Values are limited to 4 KB. A parameter already on the
  Advanced tier cannot be written through this vault: SSM refuses to move it
  back to Standard, and put fails with SSM's error.
- **New keys.** put creates a missing parameter with its tags in one call, and
  without overwrite, so a parameter created by someone else in the meantime
  makes put fail rather than be overwritten.
- **Tags.** On an existing key, put writes the value and then adds the tags.
  Tags are only ever added or updated, never removed. If the tags fail after the
  value was written, put says so.
- **Delete is immediate.** SSM keeps no recovery window or history once a
  parameter is deleted. Deleting a key that does not exist succeeds; getting one
  is a "secret not found" error.
- **Existence checks.** The vault has no `has()`: SSM cannot say whether a
  caller may decrypt a parameter without decrypting it. swamp makes one extra
  decrypting read per vault reference per run, which counts against SSM's
  throughput limit and is one KMS decrypt each time.
- **Errors** carry the AWS error name and the parameter name, never the value.

Not supported yet: `swamp vault annotate` and `inspect`, and OpenTelemetry
spans.

## Development

```sh
~/.swamp/deno/deno test --allow-net=127.0.0.1 --allow-env --allow-read \
  --allow-write --allow-sys=osRelease aws-ssm/
```

The unit tests drive the provider through a fake SSM client. The conformance
tests run the real SDK client against a local mock SSM endpoint; the SDK needs
`osRelease` for its user agent.
