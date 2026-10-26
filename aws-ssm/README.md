# @zts/aws-ssm

A swamp vault on [AWS Systems Manager Parameter Store][ssm]. Every secret is a
`SecureString` parameter, encrypted with KMS, named by the vault's prefix
followed by the secret key. Standard parameters cost nothing, so it suits small
sets of secrets that do not need Secrets Manager's rotation.

[ssm]: https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html

## Usage

```sh
swamp extension pull @zts/aws-ssm
swamp vault create @zts/aws-ssm ssm \
  --config '{"region": "eu-west-1", "parameter_prefix": "/swamp/"}'

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

## Authentication

With no `profile`, the AWS SDK's default credential chain is used: environment
variables, the shared config and credentials files (and `AWS_PROFILE`), SSO, web
identity, and container or instance roles. With `profile` set, that profile's
credentials are used even when credentials are also in the environment.
Credentials never appear in the vault's config or in swamp data.

## IAM permissions

On `arn:aws:ssm:<region>:<account>:parameter<prefix>*`:

- `ssm:GetParameter`: get, and the type check before put and delete
- `ssm:PutParameter`: put
- `ssm:AddTagsToResource`: put with tags to a key that already exists
- `ssm:DeleteParameter`: delete
- `ssm:GetParametersByPath`: list-keys

With a customer-managed `kms_key_id`, also `kms:Encrypt` and `kms:Decrypt` (and
`kms:GenerateDataKey`) on that key.

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
