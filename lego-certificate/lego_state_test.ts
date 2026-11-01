import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  certificateFiles,
  digest,
  type FileSet,
  isPublicFile,
  restore,
  snapshot,
} from "./lego_state.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "lego-state-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function write(root: string, rel: string, content: string) {
  const path = `${root}/${rel}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
}

const ACCOUNT = "accounts/acme-staging-v02.api.letsencrypt.org/me@example.com";

Deno.test("isPublicFile allows only known public lego files", () => {
  for (
    const rel of [
      `${ACCOUNT}/account.json`,
      "certificates/example.com.crt",
      "certificates/example.com.issuer.crt",
      "certificates/_.example.com.json",
    ]
  ) {
    assert(isPublicFile(rel), rel);
  }
  for (
    const rel of [
      `${ACCOUNT}/me@example.com.key`,
      "certificates/example.com.key",
      "certificates/example.com.pfx",
      "certificates/example.com.pem",
      "certificates/nested/example.com.crt",
      "accounts/account.json",
      "archives/example.com.crt",
    ]
  ) {
    assert(!isPublicFile(rel), rel);
  }
});

Deno.test("snapshot splits public and secret files and restore round-trips", async () => {
  await withTempDir(async (src) => {
    await write(src, `${ACCOUNT}/account.json`, '{"id":"me"}');
    await write(src, `${ACCOUNT}/me@example.com.key`, "ACCOUNT KEY");
    await write(src, "certificates/example.com.crt", "CERT");
    await write(src, "certificates/example.com.key", "CERT KEY");
    await write(src, "certificates/example.com.unknown", "MYSTERY");

    const accounts = await snapshot(src, "accounts");
    assertEquals(accounts, {
      files: { [`${ACCOUNT}/account.json`]: '{"id":"me"}' },
      secretFiles: { [`${ACCOUNT}/me@example.com.key`]: "ACCOUNT KEY" },
    });
    const certs = await snapshot(src, "certificates");
    assertEquals(certs.files, { "certificates/example.com.crt": "CERT" });
    assertEquals(certs.secretFiles, {
      "certificates/example.com.key": "CERT KEY",
      "certificates/example.com.unknown": "MYSTERY",
    });

    await withTempDir(async (dst) => {
      await restore(dst, accounts, "accounts");
      await restore(dst, certs, "certificates");
      assertEquals(await snapshot(dst, "accounts"), accounts);
      assertEquals(await snapshot(dst, "certificates"), certs);
      const keyMode = (await Deno.stat(`${dst}/certificates/example.com.key`))
        .mode;
      assertEquals(keyMode! & 0o777, 0o600);
      const unknownMode =
        (await Deno.stat(`${dst}/certificates/example.com.unknown`)).mode;
      assertEquals(unknownMode! & 0o777, 0o600);
    });
  });
});

Deno.test("snapshot of a missing subtree is empty", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await snapshot(dir, "certificates"), {
      files: {},
      secretFiles: {},
    });
  });
});

Deno.test("snapshot refuses a symlink", async () => {
  await withTempDir(async (dir) => {
    await write(dir, "certificates/real.crt", "CERT");
    await Deno.symlink(
      `${dir}/certificates/real.crt`,
      `${dir}/certificates/link.crt`,
    );
    await assertRejects(
      () => snapshot(dir, "certificates"),
      Error,
      "not a regular file",
    );
  });
});

Deno.test("restore refuses paths outside the subtree", async () => {
  await withTempDir(async (dir) => {
    for (
      const rel of [
        "/etc/passwd",
        "certificates/../escape.crt",
        "accounts/x.json",
        "certificates/",
        "certificates//x.crt",
        "certificates/./x.crt",
        "certificates/x\0.crt",
        "certificatesx/y.crt",
      ]
    ) {
      await assertRejects(
        () =>
          restore(
            dir,
            { files: { [rel]: "x" }, secretFiles: {} },
            "certificates",
          ),
        Error,
        "refusing",
        rel,
      );
    }
    assertEquals([...Deno.readDirSync(dir)], []);
  });
});

Deno.test("digest ignores key order and sees every change", async () => {
  const a: FileSet = {
    files: { "certificates/a.crt": "A", "certificates/b.crt": "B" },
    secretFiles: { "certificates/a.key": "K" },
  };
  const b: FileSet = {
    files: { "certificates/b.crt": "B", "certificates/a.crt": "A" },
    secretFiles: { "certificates/a.key": "K" },
  };
  assertEquals(await digest(a), await digest(b));
  assertNotEquals(
    await digest(a),
    await digest({ ...a, secretFiles: { "certificates/a.key": "K2" } }),
  );
  // Moving a file between public and secret is a change too.
  assertNotEquals(
    await digest(a),
    await digest({
      files: { "certificates/b.crt": "B" },
      secretFiles: { "certificates/a.crt": "A", "certificates/a.key": "K" },
    }),
  );
});

Deno.test("certificateFiles keeps one certificate's files", () => {
  const set: FileSet = {
    files: {
      "certificates/_.example.com.crt": "CERT",
      "certificates/_.example.com.issuer.crt": "ISSUER",
      "certificates/_.example.com.json": "{}",
    },
    secretFiles: { "certificates/_.example.com.key": "KEY" },
  };
  assertEquals(certificateFiles(set, "_.example.com"), set);
});

Deno.test("certificateFiles refuses another certificate's files", () => {
  const set: FileSet = {
    files: {
      "certificates/new.example.com.crt": "NEW",
      "certificates/old.example.com.crt": "OLD",
    },
    secretFiles: {},
  };
  assertThrows(
    () => certificateFiles(set, "new.example.com"),
    Error,
    "old.example.com.crt",
  );
});

Deno.test("certificateFiles does not mistake a longer name for its own", () => {
  // "example.com.au.crt" starts with "example.com." but is another cert.
  const set: FileSet = {
    files: {
      "certificates/example.com.crt": "CERT",
      "certificates/example.com.au.crt": "OTHER",
    },
    secretFiles: {},
  };
  assertThrows(
    () => certificateFiles(set, "example.com"),
    Error,
    "example.com.au.crt",
  );
});
