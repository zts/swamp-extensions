# @zts/lego-certificate

One ACME certificate, issued and renewed by the [lego][lego] CLI through any of
lego's [DNS-01 providers][providers]. Use it with Let's Encrypt, ZeroSSL, Google
Trust Services or any other ACME CA.

Swamp keeps all of lego's state. Each run creates a fresh temporary directory,
restores the ACME account and the certificate into it from swamp data, runs
lego, saves whatever changed and deletes the directory. Nothing stays on the
host between runs, so any machine with lego installed can renew the certificate.

Choose it over `@stack72/letsencrypt-certificate` when you want the TXT record
created for you by your DNS provider's API, rather than printed for you to add
by hand.

[lego]: https://go-acme.github.io/lego/
[providers]: https://go-acme.github.io/lego/dns/

## Requirements

lego 5 on the host, on `PATH` or at `legoPath`. lego 4 is refused: version 5
changed its flags and file layout.

```sh
brew install lego   # or a release from https://github.com/go-acme/lego/releases
lego --version      # lego version 5.x.y
```

## Usage

```sh
swamp extension pull @zts/lego-certificate
swamp behavior create @zts/lego-certificate example-cert
swamp behavior edit example-cert
```

A definition for `example.com` and `*.example.com` with the Mythic Beasts DNS
API, on Let's Encrypt's staging CA. The DNS credentials come from a vault named
`secrets`:

```yaml
globalArguments:
  domains: ["*.example.com", "example.com"]
  email: hostmaster@example.com
  dnsProvider: mythicbeasts
  dnsEnv:
    MYTHICBEASTS_USERNAME: ${{ vault.get(secrets, mythicbeasts-username) }}
  dnsSecretEnv:
    MYTHICBEASTS_PASSWORD: ${{ vault.get(secrets, mythicbeasts-password) }}
```

```sh
swamp behavior run example-cert apply     # issue now; later, renew when due
swamp behavior run example-cert status    # serial, expiry, days remaining
swamp behavior run example-cert apply --input forceRenew=true
swamp behavior run example-cert revoke --input reason=4   # 4 = superseded
```

`apply` is safe to run as often as you like. lego renews only when the
certificate is due (by the CA's renewal information, or a third of its lifetime
left), and a run that changes nothing writes nothing. Schedule it daily.

Once staging works, switch to production by setting `server`:

```yaml
server: https://acme-v02.api.letsencrypt.org/directory
```

The next `apply` registers a production account and issues a production
certificate. Each CA's account is kept, so switching back reuses it.

## Global arguments

| Argument                   | Default                  | Meaning                                                                    |
| -------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `domains`                  | required                 | Names to cover; wildcards allowed                                          |
| `dnsProvider`              | required                 | lego provider code: `mythicbeasts`, `cloudflare`, `route53`, …             |
| `dnsEnv`                   | `{}`                     | Provider settings, by environment variable (see `lego dnshelp -c <code>`)  |
| `dnsSecretEnv`             | `{}`                     | Provider credentials, by environment variable; vault references only       |
| `email`                    |                          | ACME account contact and account id; without it the id is `swamp`          |
| `server`                   | Let's Encrypt staging    | ACME directory URL                                                         |
| `certName`                 | first domain, `*` as `_` | lego's name for the certificate                                            |
| `keyType`                  | `EC256`                  | `EC256`, `EC384`, `RSA2048`, `RSA3072`, `RSA4096` or `RSA8192`             |
| `profile`                  |                          | ACME profile, such as Let's Encrypt's `shortlived`                         |
| `preferredChain`           |                          | Issuer common name of the chain to prefer                                  |
| `renewDays`                | lego's dynamic window    | Renew when fewer days than this remain                                     |
| `eabKid`, `eabHmac`        |                          | External Account Binding, for ZeroSSL, Google and others; `eabHmac` secret |
| `dnsResolvers`             |                          | Resolvers for propagation checks, as `host:port`                           |
| `dnsTimeout`               |                          | DNS query timeout, seconds                                                 |
| `dnsPropagationWait`       |                          | Skip propagation checks and wait this long, e.g. `90s`                     |
| `dnsPropagationDisableAns` | `false`                  | Don't wait for the authoritative name servers                              |
| `dnsPropagationDisableRns` | `false`                  | Don't wait for recursive resolvers                                         |
| `ambientCredentials`       | `false`                  | Pass swamp's whole environment to lego, for credential chains              |
| `legoPath`                 | `lego`                   | The lego 5 binary                                                          |
| `timeoutSeconds`           | `600`                    | Limit on one lego run; lego gets SIGTERM, then SIGKILL 10s later           |

Common ACME directory URLs:

| CA                          | `server`                                                 |
| --------------------------- | -------------------------------------------------------- |
| Let's Encrypt               | `https://acme-v02.api.letsencrypt.org/directory`         |
| Let's Encrypt staging       | `https://acme-staging-v02.api.letsencrypt.org/directory` |
| ZeroSSL (needs EAB)         | `https://acme.zerossl.com/v2/DV90`                       |
| Google Trust Services (EAB) | `https://dv.acme-v02.api.pki.goog/directory`             |

## Credentials

lego reads a DNS provider's settings from environment variables, which
`lego dnshelp -c <code>` lists. Put them in `dnsEnv`, or in `dnsSecretEnv` for
anything secret. `dnsSecretEnv` is a sensitive argument, so swamp accepts only
vault references there and masks the values in its output. Both reach lego only
through its environment, never its command line or a file, and names starting
with `LEGO_` are refused, since they would change lego's options.

By default lego gets only `PATH`, `HOME`, `TMPDIR`, `TZ`, the proxy variables,
`SSL_CERT_FILE`/`SSL_CERT_DIR`, `LEGO_CA_CERTIFICATES`/`LEGO_CA_SERVER_NAME`,
`AWS_PROFILE`/`AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` and
`GOOGLE_APPLICATION_CREDENTIALS` from swamp's environment, plus `dnsEnv` and
`dnsSecretEnv`. For a provider that uses a credential chain (Route 53 with an
instance role, ECS or EKS credentials, `AWS_ACCESS_KEY_ID` in CI), set
`ambientCredentials: true`: lego then gets swamp's whole environment, less any
`LEGO_*` variable.

The `dns-credentials` check runs before `apply` and fails when none of the
provider's credential variables is set. It is skipped with `ambientCredentials`.
The `lego-binary` check makes sure lego 5 is installed.

## Data

| Resource               | Holds                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `certificate`          | Domains, serial, validity, issuer, fingerprint, the PEMs, and lego's certificate files |
| `account-<hash>`       | One ACME account per CA and account id, with lego's account files                      |
| `log` (file, kept 30d) | lego's output from the last run                                                        |

The certificate's `privateKeyPem` and the account key are sensitive fields:
swamp stores them in the repository's vault and keeps only references in its
data. Every renewal stores a new key, so the vault gains a version each time;
`garbageCollection` keeps the last five versions of each resource.

Install the certificate from a workflow step by reading the resource, for
example into AWS Certificate Manager or a web server:

```yaml
certificate: ${{ model.example-cert.resource.certificate.certificate.attributes.certificatePem }}
chain: ${{ model.example-cert.resource.certificate.certificate.attributes.chainPem }}
privateKey: ${{ model.example-cert.resource.certificate.certificate.attributes.privateKeyPem }}
```

## Behaviour to know about

- **Changing the domains.** lego reissues when the domain list changes. If the
  first domain changes, so does the default `certName`, and the next `apply`
  issues a new certificate under the new name.
- **Changing the CA.** A certificate is reused only on the CA, account and name
  it was issued with. After a change, the next `apply` issues a new one.
- **Changing the key or chain.** A new `keyType`, `profile` or `preferredChain`
  takes effect at the next renewal. To apply it now, run `apply` with
  `--input forceRenew=true`.
- **Failures.** A failed `apply` changes no certificate data, but an account
  lego registered before failing, or before the run was aborted, is kept, so the
  retry doesn't register another. lego's output is in the `log` file.
- **Revocation.** `revoke` uses the account and CA that issued the certificate,
  whatever `server` says now. The next `apply` issues a new certificate.
- **One run at a time.** swamp locks the behavior while a method runs, so two
  renewals of one certificate cannot overlap.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
