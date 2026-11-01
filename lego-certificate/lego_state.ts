/**
 * Saves and restores lego's on-disk state as opaque path-to-content maps,
 * so that swamp, not the host, keeps it between runs.
 *
 * @module
 */

/** lego's files under one subtree, split into public and secret contents. */
export interface FileSet {
  /** Files that are safe to store in clear, by path relative to --path. */
  files: Record<string, string>;
  /** Every other file, keys included, by path relative to --path. */
  secretFiles: Record<string, string>;
}

/** The two subtrees of lego's --path that hold state worth keeping. */
export type Subtree = "accounts" | "certificates";

// Everything not listed here is secret, so a file a later lego adds is
// stored in the vault until someone decides it is public.
const PUBLIC_FILES = [
  /^accounts\/[^/]+\/[^/]+\/account\.json$/,
  /^certificates\/[^/]+\.crt$/,
  /^certificates\/[^/]+\.json$/,
];

// The files lego v5 writes for one certificate, after its name.
const CERTIFICATE_SUFFIXES = [
  ".crt",
  ".issuer.crt",
  ".key",
  ".json",
  ".pem",
  ".pfx",
];

/** Whether a path relative to lego's --path holds no secret. */
export function isPublicFile(relPath: string): boolean {
  return PUBLIC_FILES.some((pattern) => pattern.test(relPath));
}

/** Read every file under `root/subtree` into a {@link FileSet}. */
export async function snapshot(
  root: string,
  subtree: Subtree,
): Promise<FileSet> {
  const set: FileSet = { files: {}, secretFiles: {} };
  const walk = async (rel: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(`${root}/${rel}`));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(child);
      } else if (entry.isFile) {
        const content = await Deno.readTextFile(`${root}/${child}`);
        if (isPublicFile(child)) set.files[child] = content;
        else set.secretFiles[child] = content;
      } else {
        throw new Error(`lego left ${child}, which is not a regular file`);
      }
    }
  };
  await walk(subtree);
  return set;
}

function checkPath(relPath: string, subtree: Subtree): void {
  const segments = relPath.split("/");
  const safe = segments[0] === subtree && segments.length > 1 &&
    segments.every((s) => s !== "" && s !== "." && s !== "..") &&
    !relPath.includes("\0");
  if (!safe) {
    throw new Error(
      `refusing to restore ${JSON.stringify(relPath)} outside ${subtree}/`,
    );
  }
}

/**
 * Write a {@link FileSet} back under `root`. Secret files are mode 0600 and
 * directories 0700. Every path is checked before anything is written.
 */
export async function restore(
  root: string,
  set: FileSet,
  subtree: Subtree,
): Promise<void> {
  const all = [
    ...Object.entries(set.files).map(([p, c]) => [p, c, false] as const),
    ...Object.entries(set.secretFiles).map(([p, c]) => [p, c, true] as const),
  ];
  for (const [relPath] of all) checkPath(relPath, subtree);
  for (const [relPath, content, secret] of all) {
    const path = `${root}/${relPath}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(path, content, { mode: secret ? 0o600 : 0o644 });
  }
}

/** A stable SHA-256 over a {@link FileSet}, to tell whether lego changed it. */
export async function digest(set: FileSet): Promise<string> {
  const entries = [
    ...Object.entries(set.files).map(([p, c]) => ["public", p, c]),
    ...Object.entries(set.secretFiles).map(([p, c]) => ["secret", p, c]),
  ].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(hash),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/**
 * The files of the certificate named `certName` (lego's sanitised name, such
 * as `_.example.com`). Throws when `certificates/` holds any other file, since
 * that means a stale certificate and the new one could be confused.
 */
export function certificateFiles(set: FileSet, certName: string): FileSet {
  const own = new Set(
    CERTIFICATE_SUFFIXES.map((suffix) => `certificates/${certName}${suffix}`),
  );
  const stray = [...Object.keys(set.files), ...Object.keys(set.secretFiles)]
    .filter((relPath) => !own.has(relPath));
  if (stray.length > 0) {
    throw new Error(
      `lego's certificates/ holds files that are not certificate ` +
        `'${certName}': ${stray.sort().join(", ")}`,
    );
  }
  return set;
}
