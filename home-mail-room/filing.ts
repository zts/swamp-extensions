/**
 * Where a letter is filed. Shared by @zts/mail-filer and the review UI, which
 * previews the destination as the reviewer edits.
 *
 * @module
 */

/** The document types a letter is filed under. */
export const DOCUMENT_TYPES = [
  "bill",
  "statement",
  "invoice",
  "reminder",
  "notice",
  "receipt",
  "other",
] as const;

export interface FilingFields {
  sender: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  documentType: string;
  /** Replaces the document type in the file name when not empty. */
  title: string;
  /** Replaces the whole generated file name when given. */
  filename?: string;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** ISO date from its parts, or null when they make no real date. */
function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * The ISO date (YYYY-MM-DD) a letter's date means, reading numeric dates day
 * first as UK post writes them; null when it cannot tell.
 */
export function parseLetterDate(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    return month ? iso(+m[3], month, +m[1]) : null;
  }
  return null;
}

/** Text made safe as a single path segment: no separators or edge dots. */
export function cleanSegment(text: string): string {
  // deno-lint-ignore no-control-regex -- control characters are not allowed in file names
  return text.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.]+$/g, "")
    .replace(/^-+$/, "");
}

/** Why a file name given by a reviewer cannot be used; null when it can. */
export function filenameProblem(name: string): string | null {
  if (cleanSegment(name) !== name) {
    return "The file name must be one plain name, with no folders";
  }
  if (!/^.+\.pdf$/i.test(name)) return "The file name must end in .pdf";
  return null;
}

/** Articles, short prepositions and conjunctions, lower case in title case. */
const MINOR_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "to",
  "via",
]);

/** Initials that have vowels, so are not told apart by having none. */
const INITIALS = new Set(["UK", "USA"]);

/**
 * A sender as it should be written. OCR copies letterheads set in capitals,
 * so a sender read all in capitals is put in title case, as is one all in
 * lower case. A sender in capitals of under five letters is kept, as likely
 * initials (HMRC, EDF), and so is mixed case, which is taken to be how the
 * sender writes it. Within a sender in capitals, a word with no vowels
 * (HSBC, BT, PLC) and UK and USA stay in capitals.
 */
export function senderName(raw: string): string {
  const upper = raw.match(/\p{Lu}/gu)?.length ?? 0;
  const lower = raw.match(/\p{Ll}/gu)?.length ?? 0;
  if (upper > 0 && lower > 0) return raw;
  if (lower === 0 && upper < 5) return raw;
  let first = true;
  return raw.replace(/[\p{L}\p{N}'’]+/gu, (word) => {
    const isFirst = first;
    first = false;
    if (upper > 0 && (INITIALS.has(word) || !/[AEIOUY]/i.test(word))) {
      return word;
    }
    const w = word.toLowerCase();
    if (!isFirst && MINOR_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

/** Key a sender is compared by: cleaned, case and spacing ignored. */
export function senderKey(name: string): string {
  return cleanSegment(name).toLowerCase();
}

/** The existing cabinet folder a sender files into; null when there is none. */
export function matchSender(
  sender: string,
  folders: readonly string[],
): string | null {
  const key = senderKey(sender);
  if (key === "") return null;
  return folders.find((f) => senderKey(f) === key) ?? null;
}

/**
 * Where a letter is filed: <cabinet>/<sender>/<date> <sender> <title>.pdf,
 * with the document type standing in for an empty title, unless the reviewer
 * gave a file name of their own.
 */
export function destinationPath(
  cabinetDir: string,
  fields: FilingFields,
): string {
  const sender = cleanSegment(fields.sender);
  if (fields.filename) return `${cabinetDir}/${sender}/${fields.filename}`;
  const title = cleanSegment(fields.title) || cleanSegment(fields.documentType);
  return `${cabinetDir}/${sender}/${fields.date} ${sender} ${title}.pdf`;
}
