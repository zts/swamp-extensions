/**
 * The cabinet's sender renames: how a sender read off a letter is written
 * instead, kept as senders.yaml in the cabinet. A person may edit it by
 * hand; renaming a sender on the review page adds to it.
 *
 * @module
 */
import { parse, stringify } from "jsr:@std/yaml@1.0.9";
import { cleanSegment, senderKey } from "./filing.ts";

/** The renames' file name in the cabinet. */
export const SENDERS_FILE = "senders.yaml";

const HEADER =
  "# How a sender read off a letter is written, as read: written.\n" +
  "# Case and spacing in the sender as read do not matter.\n";

/** The file's renames as written, sender as read to name; empty if none. */
async function readFile(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
  const data = parse(text) ?? {};
  if (
    typeof data !== "object" || Array.isArray(data) ||
    Object.values(data).some((v) => typeof v !== "string")
  ) {
    throw new Error(
      `${path} must map each sender as read to how it is written, one per line`,
    );
  }
  return data as Record<string, string>;
}

/** The cabinet's renames: name to use, by the sender as read's key. */
export async function readSenderNames(
  cabinetDir: string,
): Promise<Map<string, string>> {
  const renames = await readFile(`${cabinetDir}/${SENDERS_FILE}`);
  return new Map(
    Object.entries(renames).flatMap(([read, name]) =>
      cleanSegment(name) ? [[senderKey(read), cleanSegment(name)]] : []
    ),
  );
}

/**
 * Add renames to the cabinet's list, replacing any for the same sender as
 * read. The file is rewritten, so comments added by hand are not kept.
 */
export async function addSenderNames(
  cabinetDir: string,
  renames: Record<string, string>,
): Promise<void> {
  const path = `${cabinetDir}/${SENDERS_FILE}`;
  const keys = new Set(Object.keys(renames).map(senderKey));
  const kept = Object.entries(await readFile(path))
    .filter(([read]) => !keys.has(senderKey(read)));
  const all = Object.fromEntries(
    [...kept, ...Object.entries(renames)].sort(([a], [b]) =>
      a.localeCompare(b)
    ),
  );
  await Deno.mkdir(cabinetDir, { recursive: true });
  const temp = `${path}.tmp`;
  await Deno.writeTextFile(temp, HEADER + stringify(all));
  await Deno.rename(temp, path);
}
