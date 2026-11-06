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

/** The page's requests, answered from the store and the header images. */
export function handler(
  store: Store,
  headers: Map<string, Uint8Array<ArrayBuffer>>,
): (req: Request) => Promise<Response> {
  const sorted = () =>
    store.letters().sort((a, b) =>
      String(a.originalName).localeCompare(String(b.originalName))
    );

  return async (req) => {
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
    return parsed.error?.message ?? parsed.message ?? out;
  } catch {
    return out.trim().split("\n").slice(-3).join(" ");
  }
}

/** The @zts/home-mail-room/review behavior. */
export const behavior = {
  type: "@zts/home-mail-room/review",
  version: "2026.11.06.1",
  globalArguments: GlobalArgsSchema,
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
        const run = async (decisions: Decision[]): Promise<void> => {
          const { code, stdout, stderr } = await new Deno.Command("swamp", {
            args: [
              "behavior",
              "run",
              filer,
              "decide",
              // A person's text is data, never an expression or an @file.
              "--literal-inputs",
              "--input",
              JSON.stringify({ decisions }),
              "--json",
            ],
            cwd: context.repoDir,
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (code !== 0) {
            const text = new TextDecoder();
            throw new Error(
              swampError(`${text.decode(stderr)}\n${text.decode(stdout)}`),
            );
          }
        };
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

        const handle = handler(store, headers);
        const server = Deno.serve({
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
