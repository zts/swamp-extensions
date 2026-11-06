/**
 * The review UI's view of the letters. Reviewers never wait on swamp: a
 * decision shows at once, and the decisions made together go to the
 * filer as one decide run in the background. If swamp refuses one, or
 * the filer holds the letter again, it goes back to review with the reason.
 *
 * @module
 */
import {
  cleanSegment,
  destinationPath,
  DOCUMENT_TYPES,
  filenameProblem,
  parseLetterDate,
} from "./filing.ts";

/** A filer letter record, named by its letter id. */
export interface Letter {
  name: string;
  state: string;
  pdfPath?: string;
  proposal?: Record<string, unknown>;
  reasons?: string[];
  destination?: string;
  [field: string]: unknown;
}

export interface LetterView extends Letter {
  sync?: "saving" | "failed";
  syncError?: string;
}

/** One decision, as the filer's decide method takes it. */
export interface Decision {
  letter: string;
  action: "file" | "skip";
  sender?: string;
  date?: string;
  documentType?: string;
  title?: string;
  filename?: string;
  overwrite?: boolean;
}

/** The states a reviewer may still decide a letter in. */
const OPEN = new Set(["held", "conflict"]);

/** Refuse filing fields the filer's decide method would refuse. */
function checkFiling(fields: Record<string, unknown>): void {
  if (cleanSegment(String(fields.sender ?? "")) === "") {
    throw new Error("A sender is needed");
  }
  const date = String(fields.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseLetterDate(date) !== date) {
    throw new Error("The date must be a real date, YYYY-MM-DD");
  }
  if (
    !(DOCUMENT_TYPES as readonly string[]).includes(String(fields.documentType))
  ) {
    throw new Error(`Unknown document type "${fields.documentType}"`);
  }
  if (fields.filename) {
    const problem = filenameProblem(String(fields.filename));
    if (problem) throw new Error(problem);
  }
}

export class Store {
  #letters = new Map<string, LetterView>();
  /** Each undecided letter as it was before its decision, by name. */
  #before = new Map<string, LetterView>();
  /** Decisions waiting to go to swamp together. */
  #waiting: Decision[] = [];
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private run: (decisions: Decision[]) => Promise<void>,
    private load: (names?: string[]) => Promise<Letter[]>,
  ) {}

  letters(): LetterView[] {
    return [...this.#letters.values()];
  }

  get(name: string): LetterView | undefined {
    return this.#letters.get(name);
  }

  /** Reload letters from swamp, keeping decisions it has not applied. */
  async refresh(names?: string[]): Promise<void> {
    for (const letter of await this.load(names)) {
      if (!this.#before.has(letter.name)) {
        this.#letters.set(letter.name, letter);
      }
    }
  }

  act(name: string, decision: Omit<Decision, "letter">): LetterView {
    return this.bulk([name], decision)[0];
  }

  /** Make the same decision on several letters; refuses all if any fails. */
  bulk(names: string[], decision: Omit<Decision, "letter">): LetterView[] {
    const planned = names.map((name) => {
      const before = this.#letters.get(name);
      if (!before) throw new Error(`No letter ${name}`);
      if (!OPEN.has(before.state) || this.#before.has(name)) {
        throw new Error(`This letter is already ${before.state}`);
      }
      const { action: _, overwrite: __, ...overrides } = decision;
      const fields = { ...before.proposal, ...overrides };
      if (decision.action === "file") checkFiling(fields);
      return { before, fields };
    });

    return planned.map(({ before, fields }) => {
      const after: LetterView = {
        ...before,
        state: decision.action === "file" ? "filed" : "skipped",
        updatedAt: new Date().toISOString(),
        ...(decision.action === "file"
          ? {
            proposal: fields,
            destination: destinationPath(
              String(before.cabinetDir ?? ""),
              fields as Parameters<typeof destinationPath>[1],
            ),
          }
          : {}),
        sync: "saving",
        syncError: undefined,
      };
      this.#letters.set(before.name, after);
      this.#before.set(before.name, before);
      this.#waiting.push({ letter: before.name, ...decision });
      this.#schedule();
      return after;
    });
  }

  /** Send the waiting decisions once the current batch has been made. */
  #schedule(): void {
    if (this.#waiting.length > 1) return;
    this.#queue = this.#queue
      .then(() => new Promise((r) => setTimeout(r, 0)))
      .then(() => this.#flush());
  }

  async #flush(): Promise<void> {
    const decisions = this.#waiting.splice(0);
    if (decisions.length === 0) return;
    const names = decisions.map((d) => d.letter);
    const befores = names.map((n) => this.#before.get(n)!);
    try {
      await this.run(decisions);
    } catch (error) {
      for (const before of befores) {
        this.#before.delete(before.name);
        this.#letters.set(before.name, {
          ...before,
          sync: "failed",
          syncError: (error as Error).message,
        });
      }
      return;
    }
    for (const name of names) this.#before.delete(name);
    await this.refresh(names);
    for (const name of names) {
      const letter = this.#letters.get(name)!;
      if (OPEN.has(letter.state)) {
        this.#letters.set(name, {
          ...letter,
          sync: "failed",
          syncError: letter.reasons?.join("; ") || "Not filed",
        });
      }
    }
  }

  /** Resolves once every decision so far has been through swamp. */
  idle(): Promise<void> {
    return this.#queue;
  }
}
