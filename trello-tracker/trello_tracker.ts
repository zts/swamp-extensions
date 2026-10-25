/**
 * A stagecraft tracker that keeps one factory's tickets on one Trello board.
 *
 * Cards are tickets, the board's open lists are statuses and its named labels
 * are ticket types. Trello has no card-to-card relations, so the tracker keeps
 * relations in its own swamp data. It meets stagecraft's tracker contract 1
 * (TRACKERS.md in @swamp/stagecraft) and is placed behind a
 * `@swamp/stagecraft/publisher`.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";

/** The name stagecraft keeps this tracker's ticket ids under. */
export const TRACKER = "trello";

/** Trello refuses card descriptions, names and comments longer than this. */
export const TEXT_LIMIT = 16384;

/** How long one Trello request may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;

const API = "https://api.trello.com/1";

const CARD_FIELDS = [
  "id",
  "idBoard",
  "idShort",
  "shortLink",
  "shortUrl",
  "name",
  "desc",
  "idList",
  "idLabels",
  "dateLastActivity",
].join(",");

const RELATION_TYPES = [
  "parent_of",
  "blocked_by",
  "related_to",
  "duplicate_of",
] as const;

const OPERATIONS = [
  "fetch_issue",
  "create",
  "comment",
  "set_status",
  "relate",
  "unrelate",
  "post_entry",
  "set_type",
  "assign",
  "link_pr",
] as const;

const GlobalArgsSchema = z.object({
  boardId: z.string().min(1).describe("The board's id or shortLink"),
  prefix: z.string().regex(/^[a-z][a-z0-9-]{0,11}$/).default("trello")
    .describe("Leads every display id: <prefix>-<card number>"),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Trello API key, from a vault",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "Trello user token with read,write scope, from a vault",
  ),
});

/** Global arguments of a Trello tracker instance. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RelationSchema = z.object({
  type: z.enum(RELATION_TYPES),
  direction: z.enum(["outgoing", "incoming"]),
  issue: z.string(),
  display: z.string(),
});
type Relation = z.infer<typeof RelationSchema>;

const RelationsSchema = z.object({
  card: z.string(),
  relations: z.array(RelationSchema),
});

const CardSchema = z.object({
  id: z.string(),
  idBoard: z.string(),
  idShort: z.number(),
  shortLink: z.string(),
  shortUrl: z.string(),
  name: z.string(),
  desc: z.string(),
  idList: z.string(),
  idLabels: z.array(z.string()),
  dateLastActivity: z.string().nullable().optional(),
});
type Card = z.infer<typeof CardSchema>;

const NamedSchema = z.object({ id: z.string(), name: z.string().nullable() });
type Named = z.infer<typeof NamedSchema>;

const ActionSchema = z.object({
  id: z.string(),
  date: z.string(),
  data: z.object({ text: z.string() }),
  memberCreator: z.object({ username: z.string() }).optional(),
});

type FailureKind =
  | "auth"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "upstream";

/** A failure every tracker reports the same way: one of five kinds. */
class Failure extends Error {
  constructor(readonly kind: FailureKind, readonly detail: string) {
    super(detail);
  }
}

interface Context {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: { info(message: string, props: Record<string, unknown>): void };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** What a Trello request failed with, mapped by where it was asked. */
type Scope = "board" | "card" | "other";

function failureFor(
  scope: Scope,
  status: number,
  what: string,
  body: string,
  retryAfter: string | null,
): Failure {
  const detail = `Trello ${what} failed with HTTP ${status}: ${
    body.slice(0, 200)
  }`;
  if (status === 429) {
    const wait = retryAfter
      ? ` (Retry-After: ${retryAfter.slice(0, 200)})`
      : "";
    return new Failure("rate_limited", `${detail}${wait}`);
  }
  if (scope === "card" && [400, 401, 403, 404].includes(status)) {
    return new Failure("not_found", `${what}: no such card on the board`);
  }
  if (scope === "board" && (status === 400 || status === 404)) {
    return new Failure(
      "upstream",
      `${detail}; check the tracker's boardId and that the token can read it`,
    );
  }
  if (status === 401 || status === 403) return new Failure("auth", detail);
  if (status === 400) return new Failure("invalid", detail);
  if (status === 404) return new Failure("not_found", detail);
  return new Failure("upstream", detail);
}

/** A Trello REST client that keeps the credentials in the header only. */
function client(ctx: Context) {
  const { apiKey, token } = ctx.globalArgs;
  const authorization =
    `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`;
  return async (
    scope: Scope,
    method: "GET" | "POST" | "PUT",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> => {
    const query = new URLSearchParams(options.query ?? {}).toString();
    const what = `${method} ${path}`;
    let response: Response;
    try {
      response = await fetch(`${API}${path}${query ? `?${query}` : ""}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal: AbortSignal.any([
          ctx.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      throw new Failure("upstream", `Trello ${what} did not answer: ${name}`);
    }
    if (!response.ok) {
      throw failureFor(
        scope,
        response.status,
        what,
        await response.text(),
        response.headers.get("Retry-After"),
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Failure(
        "upstream",
        `Trello ${what} returned a body that is not JSON`,
      );
    }
  };
}

type Call = ReturnType<typeof client>;

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Failure("upstream", `Trello ${what} returned an unexpected body`);
  }
  return result.data;
}

/** The one item named `name`, or an invalid failure naming the choices. */
function oneNamed(items: Named[], name: string, kind: string): Named {
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1) {
    throw new Failure("invalid", `more than one ${kind} is named '${name}'`);
  }
  if (matches.length === 0) {
    const names = items.map((item) => item.name).join(", ");
    const where = kind === "label" ? " on the board" : "";
    throw new Failure("invalid", `no ${kind} '${name}'${where}: ${names}`);
  }
  return matches[0];
}

function withinLimit(value: string, what: string): string {
  if (value.length > TEXT_LIMIT) {
    throw new Failure(
      "invalid",
      `${what} is ${value.length} characters; Trello allows ${TEXT_LIMIT}`,
    );
  }
  return value;
}

/** The board, its lists, labels and cards, scoped to the configured board. */
function trello(ctx: Context, call: Call) {
  const { boardId, prefix } = ctx.globalArgs;
  let board: string | undefined;

  const boardOf = async (): Promise<string> => {
    if (board === undefined) {
      const found = parsed(
        z.object({ id: z.string() }),
        await call("board", "GET", `/boards/${encodeURIComponent(boardId)}`, {
          query: { fields: "id,name" },
        }),
        `board ${boardId}`,
      );
      board = found.id;
    }
    return board;
  };

  const display = (card: Card) => `${prefix}-${card.idShort}`;

  /** Every operation that takes an issue resolves it here, on the board. */
  const card = async (ref: string): Promise<Card> => {
    const id = await boardOf();
    const short = new RegExp(`^${prefix}-(\\d+)$`, "i").exec(ref);
    let path: string;
    if (short !== null) path = `/boards/${id}/cards/${short[1]}`;
    else if (/^([0-9a-f]{24}|[A-Za-z0-9]{8})$/.test(ref)) {
      path = `/cards/${ref}`;
    } else throw new Failure("not_found", `no ticket ${ref} on the board`);
    const found = parsed(
      CardSchema,
      await call("card", "GET", path, { query: { fields: CARD_FIELDS } }),
      `card ${ref}`,
    );
    if (found.idBoard !== id) {
      throw new Failure("not_found", `no ticket ${ref} on the board`);
    }
    return found;
  };

  const openLists = async (): Promise<Named[]> => {
    const lists = parsed(
      z.array(NamedSchema.extend({ pos: z.number() })),
      await call("other", "GET", `/boards/${await boardOf()}/lists`, {
        query: { filter: "open", fields: "id,name,pos" },
      }),
      "lists",
    );
    return lists.sort((a, b) => a.pos - b.pos);
  };

  const namedLabels = async (): Promise<Named[]> => {
    const labels = parsed(
      z.array(NamedSchema),
      await call("other", "GET", `/boards/${await boardOf()}/labels`, {
        query: { fields: "id,name", limit: "1000" },
      }),
      "labels",
    );
    return labels.filter((label) => label.name);
  };

  const listName = async (idList: string): Promise<string> => {
    const list = parsed(
      NamedSchema,
      await call("other", "GET", `/lists/${idList}`, {
        query: { fields: "id,name" },
      }),
      `list ${idList}`,
    );
    return list.name ?? "";
  };

  /** Every comment on the card, oldest first, paged backwards in full. */
  const comments = async (idCard: string) => {
    const newestFirst: z.infer<typeof ActionSchema>[] = [];
    let before: string | undefined;
    for (;;) {
      const page = parsed(
        z.array(ActionSchema),
        await call("other", "GET", `/cards/${idCard}/actions`, {
          query: {
            filter: "commentCard",
            limit: "1000",
            ...(before === undefined ? {} : { before }),
          },
        }),
        "comments",
      );
      newestFirst.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].id;
    }
    return newestFirst.reverse().map((action) => ({
      kind: "comment" as const,
      id: action.id,
      ...(action.memberCreator
        ? { author: action.memberCreator.username }
        : {}),
      body: action.data.text,
      at: action.date,
    }));
  };

  return {
    boardOf,
    card,
    display,
    openLists,
    namedLabels,
    listName,
    comments,
  };
}

/** Relations, kept per card in this instance's records. */
function relationStore(ctx: Context) {
  const name = (card: string) => `relations-${card}`;
  const read = async (card: string): Promise<Relation[]> => {
    const raw = await ctx.readResource(name(card));
    return raw === null ? [] : RelationsSchema.parse(raw).relations;
  };
  const write = async (card: string, relations: Relation[]) => {
    await ctx.writeResource("relations", name(card), { card, relations });
  };
  return { read, write };
}

const same = (a: Relation, b: Relation) =>
  a.type === b.type && a.direction === b.direction && a.issue === b.issue;

/** The rules every tracker keeps for relations, refusing as invalid. */
async function checkRelate(
  read: (card: string) => Promise<Relation[]>,
  from: { id: string; display: string; relations: Relation[] },
  type: Relation["type"],
  to: { id: string; display: string; relations: Relation[] },
): Promise<void> {
  const refuse = (detail: string): never => {
    throw new Failure("invalid", detail);
  };
  if (from.id === to.id) refuse(`${from.display} cannot be related to itself`);
  const parentOf = (relations: Relation[]) =>
    relations.find((r) => r.type === "parent_of" && r.direction === "incoming");
  if (type === "parent_of") {
    const parent = parentOf(to.relations);
    if (parent !== undefined) {
      refuse(`${to.display} already has a parent, ${parent.display}`);
    }
    // Up from the new parent, 10 deep: reaching the child closes a loop.
    const seen = new Set([to.id]);
    let current = from.relations;
    for (let depth = 0; depth < 10; depth++) {
      const up = parentOf(current);
      if (up === undefined) break;
      if (seen.has(up.issue)) refuse("that would form a circular parent chain");
      seen.add(up.issue);
      current = await read(up.issue);
    }
  }
  if (type === "duplicate_of") {
    const out = (relations: Relation[]) =>
      relations.find((r) =>
        r.type === "duplicate_of" && r.direction === "outgoing"
      );
    if (out(from.relations) !== undefined) {
      refuse(`${from.display} is already a duplicate`);
    }
    if (out(to.relations) !== undefined) {
      refuse(`${to.display} is itself a duplicate`);
    }
    if (
      from.relations.some((r) =>
        r.type === "duplicate_of" && r.direction === "incoming"
      )
    ) refuse(`${from.display} has duplicates of its own`);
  }
}

/** One operation, made on the board. */
async function perform(
  ctx: Context,
  operation: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = (name: string) => {
    const value = request[name];
    if (typeof value !== "string") {
      throw new Failure("invalid", `${operation} needs ${name}`);
    }
    return value;
  };
  const relations = relationStore(ctx);

  switch (operation) {
    case "fetch_issue":
    case "create":
    case "comment":
    case "set_status":
    case "relate":
    case "unrelate":
      break;
    default:
      throw new Failure(
        "invalid",
        `the Trello tracker does not offer '${operation}'`,
      );
  }

  // Lengths are checked before any request, so a refusal costs nothing.
  if (operation === "comment") withinLimit(text("body"), "the comment");
  if (operation === "create") {
    withinLimit(text("title"), "the title");
    withinLimit(text("body"), "the body");
  }
  let relationType: Relation["type"] | undefined;
  if (operation === "relate" || operation === "unrelate") {
    const parsedType = z.enum(RELATION_TYPES).safeParse(request.type);
    if (!parsedType.success) {
      throw new Failure(
        "invalid",
        `no relation type '${String(request.type)}': ${
          RELATION_TYPES.join(", ")
        }`,
      );
    }
    relationType = parsedType.data;
  }

  const http = client(ctx);
  const board = trello(ctx, http);

  const ticketOf = async (
    card: Card,
    status: Named,
    activity: Awaited<ReturnType<typeof board.comments>>,
  ) => {
    const labels = await board.namedLabels();
    return {
      id: card.id,
      display: board.display(card),
      title: card.name,
      url: card.shortUrl,
      status: { id: status.id, name: status.name ?? "" },
      relations: await relations.read(card.id),
      description: card.desc,
      labels: labels
        .filter((label) => card.idLabels.includes(label.id))
        .map((label) => label.name),
      assignees: [],
      createdAt: new Date(parseInt(card.id.slice(0, 8), 16) * 1000)
        .toISOString(),
      updatedAt: card.dateLastActivity ?? null,
      activity,
    };
  };

  switch (operation) {
    case "fetch_issue": {
      const card = await board.card(text("issue"));
      const status = {
        id: card.idList,
        name: await board.listName(card.idList),
      };
      return await ticketOf(card, status, await board.comments(card.id));
    }
    case "create": {
      const id = await board.boardOf();
      const label = oneNamed(await board.namedLabels(), text("type"), "label");
      const [first] = await board.openLists();
      if (first === undefined) {
        throw new Failure("invalid", "the board has no open list");
      }
      const card = parsed(
        CardSchema,
        await http("other", "POST", "/cards", {
          body: {
            idList: first.id,
            name: text("title"),
            desc: text("body"),
            idLabels: [label.id],
            pos: "bottom",
          },
        }),
        `new card on board ${id}`,
      );
      return await ticketOf(card, first, []);
    }
    case "comment": {
      const card = await board.card(text("issue"));
      const action = parsed(
        z.object({ id: z.string() }),
        await http("other", "POST", `/cards/${card.id}/actions/comments`, {
          body: { text: text("body") },
        }),
        "comment",
      );
      return { id: action.id, url: `${card.shortUrl}#comment-${action.id}` };
    }
    case "set_status": {
      const card = await board.card(text("issue"));
      const list = oneNamed(
        await board.openLists(),
        text("status"),
        "open list",
      );
      const changed = card.idList !== list.id;
      if (changed) {
        await http("other", "PUT", `/cards/${card.id}`, {
          body: { idList: list.id },
        });
      }
      return { changed, status: { id: list.id, name: list.name ?? "" } };
    }
    default: {
      const type = relationType!;
      const fromCard = await board.card(text("issue"));
      let toCard: Card;
      try {
        toCard = await board.card(text("to"));
      } catch (error) {
        if (
          operation !== "unrelate" || !(error instanceof Failure) ||
          error.kind !== "not_found"
        ) throw error;
        // The other card is gone or off the board: remove this card's side
        // by the id or display it was stored under, or the relation could
        // never be removed.
        const ref = text("to").toLowerCase();
        const stored = await relations.read(fromCard.id);
        const kept = stored.filter((r) =>
          !(r.type === type && r.direction === "outgoing" &&
            (r.issue.toLowerCase() === ref ||
              r.display.toLowerCase() === ref))
        );
        if (kept.length === stored.length) throw error;
        await relations.write(fromCard.id, kept);
        return { changed: true };
      }
      const from = {
        id: fromCard.id,
        display: board.display(fromCard),
        relations: await relations.read(fromCard.id),
      };
      const to = {
        id: toCard.id,
        display: board.display(toCard),
        relations: await relations.read(toCard.id),
      };
      const outgoing: Relation = {
        type,
        direction: "outgoing",
        issue: to.id,
        display: to.display,
      };
      const incoming: Relation = {
        type,
        direction: "incoming",
        issue: from.id,
        display: from.display,
      };
      const hasOut = from.relations.some((r) => same(r, outgoing));
      const hasIn = to.relations.some((r) => same(r, incoming));
      if (operation === "relate") {
        // A side already there was checked when it was written; complete
        // a half-written relation rather than refusing it.
        if (!hasOut && !hasIn) {
          await checkRelate(relations.read, from, type, to);
        }
        if (!hasOut) {
          await relations.write(from.id, [...from.relations, outgoing]);
        }
        if (!hasIn) await relations.write(to.id, [...to.relations, incoming]);
        return { changed: !hasOut || !hasIn };
      }
      // unrelate removes each side that is present, so a retry finishes a
      // half-removed relation.
      if (hasOut) {
        await relations.write(
          from.id,
          from.relations.filter((r) => !same(r, outgoing)),
        );
      }
      if (hasIn) {
        await relations.write(
          to.id,
          to.relations.filter((r) => !same(r, incoming)),
        );
      }
      return { changed: hasOut || hasIn };
    }
  }
}

const AnswerSchema = z.object({ ok: z.boolean() }).passthrough();

/** The Trello tracker: a stagecraft tracker that keeps tickets on a board. */
export const behavior = {
  type: "@zts/trello-tracker",
  version: "2026.10.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    relations: {
      description: "Each card's relations, which Trello cannot hold itself",
      schema: RelationsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    answer: {
      description: "operate's answers, under the names they were given",
      schema: AnswerSchema,
      lifetime: "infinite" as const,
      garbageCollection: "30d",
    },
    description: {
      description: "What this tracker says of itself",
      schema: z.object({
        tracker: z.string(),
        contract: z.number().int(),
        origin: z.string(),
        capabilities: z.object({
          history: z.boolean(),
          assign: z.boolean(),
          pullRequests: z.boolean(),
        }).strict(),
        closesDuplicates: z.boolean(),
      }).strict(),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    describe: {
      description: "Record what this tracker is, for stagecraft to bind to",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const handle = await ctx.writeResource("description", "description", {
          tracker: TRACKER,
          contract: 1,
          origin: "snapshot",
          capabilities: { history: false, assign: false, pullRequests: false },
          closesDuplicates: false,
        });
        return { dataHandles: [handle] };
      },
    },
    operate: {
      description:
        "Make one tracker operation on the board and write its answer under the given name; an answer that succeeded is never made again",
      arguments: z.object({
        operation: z.enum(OPERATIONS),
        request: z.union([z.record(z.string(), z.unknown()), z.string()]),
        answer: z.string().regex(/^answer-[A-Za-z0-9._-]+$/),
        run: z.string().optional(),
      }),
      execute: async (
        args: {
          operation: string;
          request: Record<string, unknown> | string;
          answer: string;
          run?: string;
        },
        ctx: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const prior = await ctx.readResource(args.answer);
        if (prior?.ok === true) return { dataHandles: [] };
        ctx.logger.info("Trello tracker {operation} on board {board}", {
          operation: args.operation,
          board: ctx.globalArgs.boardId,
        });
        const run = args.run === undefined ? {} : { run: args.run };
        let answer: Record<string, unknown>;
        try {
          let request: unknown;
          try {
            request = typeof args.request === "string"
              ? JSON.parse(args.request)
              : args.request;
          } catch {
            request = undefined;
          }
          if (
            typeof request !== "object" || request === null ||
            Array.isArray(request)
          ) throw new Failure("invalid", "the request is not a JSON object");
          const result = await perform(
            ctx,
            args.operation,
            request as Record<string, unknown>,
          );
          answer = { operation: args.operation, ...run, ok: true, result };
        } catch (error) {
          const failure = error instanceof Failure ? error : new Failure(
            "upstream",
            error instanceof Error ? error.name : "error",
          );
          answer = {
            operation: args.operation,
            ...run,
            ok: false,
            kind: failure.kind,
            detail: failure.detail,
          };
        }
        const handle = await ctx.writeResource("answer", args.answer, answer);
        ctx.logger.info("Trello tracker {operation} answered ok={ok}", {
          operation: args.operation,
          ok: answer.ok,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
