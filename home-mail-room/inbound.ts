/**
 * The Inbound folders letters move through, and the moves between them.
 * The scanner takes letters out of Incoming and the filer out of ReadyToFile,
 * so no two behaviors move the same file.
 *
 * A letter is known by its content: the SHA-256 of the PDF. Its records are
 * named after the first 16 hex of it, whatever the file is called.
 *
 * @module
 */

/** The folders under Inbound, by what is in them. */
export const FOLDERS = {
  /** New scans, not yet read. */
  incoming: "Incoming",
  /** Scans that could not be read: not a PDF, or no answer from the model. */
  failed: "Failed",
  /** Read, waiting to be filed by the filer or by a person. */
  readyToFile: "ReadyToFile",
  /** A person chose not to file these. */
  skipped: "Skipped",
  /** Originals of letters copied into the FileCabinet. */
  archived: "Archived",
} as const;

export type Folder = keyof typeof FOLDERS;

/** A directory: absolute, or relative to the repository. */
export function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/** One of the Inbound folders. */
export function folder(inboundDir: string, which: Folder): string {
  return `${inboundDir}/${FOLDERS[which]}`;
}

/** SHA-256 of the bytes, in lowercase hex. */
export async function contentHash(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The short id a letter's records are named by. */
export function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

/** The SHA-256 of a file, or null when there is no file there. */
export async function fileHash(path: string): Promise<string | null> {
  try {
    return await contentHash(await Deno.readFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export interface Pdf {
  path: string;
  hash: string;
}

/**
 * The PDFs in a folder (not recursive), sorted by path, with their hashes.
 * A missing folder has none; a broken link is skipped with a warning.
 */
export async function pdfsIn(
  dir: string,
  warn: (message: string, props: Record<string, unknown>) => void = () => {},
): Promise<Pdf[]> {
  const pdfs: Pdf[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!/\.pdf$/i.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isSymlink) {
        const target = await Deno.stat(path).catch(() => null);
        if (!target) {
          warn("Skipping {path}: its link is broken", { path });
          continue;
        }
        if (!target.isFile) continue;
      } else if (!entry.isFile) continue;
      const hash = await fileHash(path);
      // Gone between listing and reading: another run took it.
      if (hash !== null) pdfs.push({ path, hash });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return pdfs.sort((a, b) => a.path.localeCompare(b.path));
}

/** The names a file may take in a folder it is moved into. */
function movedNames(dir: string, path: string, hash: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return [`${dir}/${base}`, `${dir}/${shortHash(hash)}-${base}`];
}

/** Where in a folder a moved file already is, if it is there. */
export async function movedTo(
  dir: string,
  path: string,
  hash: string,
): Promise<string | null> {
  for (const name of movedNames(dir, path, hash)) {
    if (await fileHash(name) === hash) return name;
  }
  return null;
}

/**
 * Move a file, unchanged, into a folder: under its own name, or prefixed
 * with its short hash when another file has that name. A move an
 * interrupted run already made counts as done. Returns where it is now.
 */
export async function moveInto(
  dir: string,
  path: string,
  hash: string,
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const already = await movedTo(dir, path, hash);
  if (already) {
    if (already !== path && await fileHash(path) === hash) {
      await Deno.remove(path);
    }
    return already;
  }
  for (const name of movedNames(dir, path, hash)) {
    if (await fileHash(name) !== null) continue;
    await Deno.rename(path, name);
    return name;
  }
  throw new Error(`Other files already have the names of ${path} in ${dir}`);
}
