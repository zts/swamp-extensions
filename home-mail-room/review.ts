/**
 * Serves the review page on 127.0.0.1, where a person files or skips the
 * letters the filer held. It shows each letter beside what was read off it,
 * previews where it would be filed as fields are edited, and sends the
 * decisions to the filer's decide method, several at a time.
 *
 * It is a behavior of its own, not a method of the filer, so a review
 * session never holds the filer's lock: the filer files while it runs.
 * Decisions go through the swamp CLI, because a method may call runModel
 * only 100 times and a review session makes many more decisions than that.
 *
 *   swamp behavior run review serve
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { destinationPath, filenameProblem, parseLetterDate } from "./filing.ts";
import { PAGE_HTML } from "./review_page.ts";
import { type Decision, type Letter, Store } from "./review_store.ts";

const NAME = /^[A-Za-z0-9_-]+$/;
const LETTER = /^letter-[0-9a-f]{16}$/;
/** How often to look for letters the filer held since the last look. */
const REFRESH_MS = 30_000;

const GlobalArgsSchema = z.object({
  filer: z.string().regex(NAME).default("filer").describe(
    "The @zts/home-mail-room/filer instance whose letters are reviewed",
  ),
});

const ServeArgsSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(8787).describe(
    "The port on 127.0.0.1; 0 picks a free one",
  ),
});

interface DataRecord {
  name: string;
  version?: number;
  modelId?: string;
  modelType?: string;
  attributes?: Record<string, unknown>;
}

interface Context {
  globalArgs: z.input<typeof GlobalArgsSchema>;
  repoDir: string;
  signal?: AbortSignal;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
  queryData(predicate: string): Promise<unknown[]>;
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
    ): Promise<Uint8Array | null>;
  };
}

/** The latest version of each record, by name. */
function latestByName(records: DataRecord[]): DataRecord[] {
  const latest = new Map<string, DataRecord>();
  for (const r of records) {
    const seen = latest.get(r.name);
    if (!seen || (r.version ?? 0) > (seen.version ?? 0)) latest.set(r.name, r);
  }
  return [...latest.values()];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The first of these PDFs that exists. */
async function pdf(paths: unknown[]): Promise<Response> {
  for (const path of paths) {
    if (typeof path !== "string") continue;
    try {
      const file = await Deno.open(path);
      return new Response(file.readable, {
        headers: { "content-type": "application/pdf" },
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return json({ error: "The PDF is not there" }, 404);
}

/**
 * Why a request is refused, or null for one from the page itself. Binding
 * to 127.0.0.1 keeps other machines out but not other web pages open in
 * the person's browser: DNS rebinding sends their requests here with
 * their own Host, and a cross-origin POST carries their Origin.
 */
function foreign(req: Request, port: number): string | null {
  const ours = (url: URL) =>
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    (url.port || "80") === String(port);
  // Deno.serve builds req.url from the Host header.
  if (!ours(new URL(req.url))) {
    return "This page answers only at its own address";
  }
  const origin = req.headers.get("origin");
  if (req.method === "POST" && origin !== null) {
    // "null", and an origin that is not a URL, are not the page's.
    const from = URL.canParse(origin) ? new URL(origin) : null;
    if (from?.protocol !== "http:" || !ours(from)) {
      return "Only the review page may change letters";
    }
  }
  return null;
}

/**
 * Whether a request's body is JSON, by its media type alone. A web page can
 * send another site a form or text/plain POST without asking first, but
 * not an application/json one.
 */
function isJson(req: Request): boolean {
  const type = req.headers.get("content-type") ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * The page's requests, answered from the store and the header images. A
 * rename goes to the filer once the decisions before it have. port is the
 * one the server listens on, which is known only once it does.
 */
export function handler(
  store: Store,
  headers: Map<string, Uint8Array<ArrayBuffer>>,
  rename: (names: string[], sender: string) => Promise<void>,
  port: () => number,
): (req: Request) => Promise<Response> {
  const sorted = () =>
    store.letters().sort((a, b) =>
      String(a.originalName).localeCompare(String(b.originalName))
    );

  return async (req) => {
    const refused = foreign(req, port());
    if (refused) return json({ error: refused }, 403);
    if (req.method === "POST" && !isJson(req)) {
      return json({ error: "Send application/json" }, 415);
    }
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/letters") return json(sorted());
    if (url.pathname === "/api/preview") {
      const p = url.searchParams;
      const letter = store.get(p.get("letter") ?? "");
      const fields = {
        sender: p.get("sender") ?? "",
        date: p.get("date") ?? "",
        documentType: p.get("documentType") ?? "",
        title: p.get("title") ?? "",
        filename: p.get("filename") || undefined,
      };
      const problem = fields.filename ? filenameProblem(fields.filename) : null;
      const ok = letter !== undefined && fields.sender.trim() !== "" &&
        !problem && parseLetterDate(fields.date) === fields.date;
      return json({
        path: ok
          ? destinationPath(String(letter.cabinetDir ?? ""), fields)
          : null,
        problem,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/bulk") {
      const body = await req.json() as {
        names: string[];
        decision: Omit<Decision, "letter">;
      };
      try {
        return json(store.bulk(body.names, body.decision));
      } catch (error) {
        return json({ error: (error as Error).message }, 422);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/rename") {
      const body = await req.json() as { names: string[]; sender: string };
      if (String(body.sender ?? "").trim() === "") {
        return json({ error: "The sender's name cannot be empty" }, 422);
      }
      await store.idle();
      try {
        await rename(body.names, body.sender);
      } catch (error) {
        return json({ error: (error as Error).message }, 422);
      }
      await store.refresh();
      return json(sorted());
    }
    if (parts[0] === "api" && parts[1] === "letters" && parts[2]) {
      const letter = LETTER.test(parts[2]) ? store.get(parts[2]) : undefined;
      if (!letter) return json({ error: "No such letter" }, 404);
      if (req.method === "GET" && parts[3] === "pdf") {
        // The original, wherever it is now: ReadyToFile, Archived or Skipped.
        return pdf([letter.pdfPath, letter.archivedPath]);
      }
      if (req.method === "GET" && parts[3] === "existing") {
        // What is already at the destination of a letter in conflict.
        return pdf([letter.destination]);
      }
      if (req.method === "GET" && parts[3] === "header") {
        const png = headers.get(letter.name);
        return png
          ? new Response(png, {
            headers: {
              "content-type": "image/png",
              "cache-control": "private, max-age=3600",
            },
          })
          : json({ error: "No header image" }, 404);
      }
      if (req.method === "POST" && parts[3] === "decide") {
        const decision = await req.json() as Omit<Decision, "letter">;
        try {
          return json(store.act(letter.name, decision));
        } catch (error) {
          return json({ error: (error as Error).message }, 422);
        }
      }
    }
    return json({ error: "Not found" }, 404);
  };
}

/** The part of a failed swamp run worth showing a person. */
function swampError(out: string): string {
  try {
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    // swamp --json writes { "error": "<message>", "code": "..." }.
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? out;
  } catch {
    return out.trim().split("\n").slice(-3).join(" ");
  }
}

/** What a command gave back once it ended. */
export interface CommandOutput {
  /** The exit code. */
  code: number;
  /** All it wrote to stdout. */
  stdout: Uint8Array;
  /** All it wrote to stderr. */
  stderr: Uint8Array;
}

/** Runs a command in a folder to its end; tests give their own. */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandOutput>;

const runCommand: CommandRunner = (command, args, cwd) =>
  // The review page exists to send a person's decisions to the filer, and
  // swamp is how it does: runModel allows only 100 calls per method run.
  // The argv is fixed but for validated names and one JSON input that
  // --literal-inputs keeps from being read as an expression or @file.
  // swamp-quality-ignore deno-command
  new Deno.Command(command, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();

/**
 * Runs one of the filer's methods through the swamp CLI, in the repository,
 * and throws what swamp said when it fails.
 */
export async function runFilerMethod(
  repoDir: string,
  filer: string,
  method: string,
  input: Record<string, unknown>,
  run: CommandRunner = runCommand,
): Promise<void> {
  let output: CommandOutput;
  try {
    output = await run("swamp", [
      "behavior",
      "run",
      filer,
      method,
      // A person's text is data, never an expression or an @file.
      "--literal-inputs",
      "--input",
      JSON.stringify(input),
      "--json",
    ], repoDir);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      "swamp is not on PATH: the review page files letters through the swamp CLI",
    );
  }
  const { code, stdout, stderr } = output;
  if (code !== 0) {
    const text = new TextDecoder();
    throw new Error(
      swampError(`${text.decode(stderr)}\n${text.decode(stdout)}`),
    );
  }
}

/** The @zts/home-mail-room/review behavior. */
export const behavior = {
  type: "@zts/home-mail-room/review",
  version: "2026.11.07.1",
  globalArguments: GlobalArgsSchema,
  // Instances made before the first release, at 2026.11.06.1.
  upgrades: [
    {
      toVersion: "2026.11.07.1",
      description:
        "Refuses other hosts and origins and non-JSON POSTs; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  methods: {
    serve: {
      description:
        "Serve the review page on 127.0.0.1 until Ctrl-C: file or skip the letters the filer held",
      arguments: ServeArgsSchema,
      execute: async (
        args: z.input<typeof ServeArgsSchema>,
        context: Context,
      ) => {
        const { port } = ServeArgsSchema.parse(args);
        const { filer } = GlobalArgsSchema.parse(context.globalArgs);

        const load = async (names?: string[]): Promise<Letter[]> => {
          const only = names ? ` && name in ${JSON.stringify(names)}` : "";
          const records = latestByName(
            await context.queryData(
              `modelName == ${JSON.stringify(filer)} && specName == "letter"` +
                only,
            ) as DataRecord[],
          );
          return records.map((r) =>
            ({
              ...(r.attributes ?? {}),
              name: r.name,
            }) as Letter
          );
        };
        // Through the CLI: runModel allows 100 calls per method run.
        const runFiler = (method: string, input: Record<string, unknown>) =>
          runFilerMethod(context.repoDir, filer, method, input);
        const run = (decisions: Decision[]) =>
          runFiler("decide", { decisions });
        const rename = (letters: string[], sender: string) =>
          runFiler("renameSender", { letters, sender });
        const store = new Store(run, load);

        const headers = new Map<string, Uint8Array<ArrayBuffer>>();
        const loadHeaders = async () => {
          const missing = store.letters().map((l) => l.name)
            .filter((n) => !headers.has(n))
            .map((n) => n.replace(/^letter-/, "header-"));
          if (missing.length === 0) return;
          const records = latestByName(
            await context.queryData(
              `modelName == ${JSON.stringify(filer)} && name in ${
                JSON.stringify(missing)
              }`,
            ) as DataRecord[],
          );
          for (const r of records) {
            if (!r.modelType || !r.modelId) continue;
            const png = await context.dataRepository.getContent(
              r.modelType,
              r.modelId,
              r.name,
            );
            if (png) {
              headers.set(
                r.name.replace(/^header-/, "letter-"),
                new Uint8Array(png),
              );
            }
          }
        };
        const refresh = async () => {
          await store.refresh();
          await loadHeaders();
        };

        await refresh();
        const stop = new AbortController();
        const onSignal = () => stop.abort();
        Deno.addSignalListener("SIGINT", onSignal);
        context.signal?.addEventListener("abort", onSignal);
        const timer = setInterval(() => {
          // Wait for decisions on their way, so a refresh never races one.
          store.idle().then(refresh).catch((error) =>
            context.logger.warning("Refresh failed: {message}", {
              message: (error as Error).message,
            })
          );
        }, REFRESH_MS);

        // The port asked for may be 0, so the page's own is the one bound.
        const handle = handler(store, headers, rename, () => server.addr.port);
        const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({
          hostname: "127.0.0.1",
          port,
          signal: stop.signal,
          onListen: ({ port }) =>
            context.logger.info(
              "Reviewing {filer}'s letters at http://127.0.0.1:{port}/ until Ctrl-C",
              { filer, port },
            ),
        }, async (req) => {
          try {
            return await handle(req);
          } catch (error) {
            return json({ error: (error as Error).message }, 500);
          }
        });
        try {
          await server.finished;
          // Decisions already made still reach the filer.
          await store.idle();
        } finally {
          clearInterval(timer);
          Deno.removeSignalListener("SIGINT", onSignal);
          context.signal?.removeEventListener("abort", onSignal);
        }
        return { dataHandles: [] };
      },
    },
  },
};
