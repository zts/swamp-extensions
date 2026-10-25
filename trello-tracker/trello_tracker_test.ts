import { assertEquals, assertExists } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { behavior, TEXT_LIMIT } from "./trello_tracker.ts";

const KEY = "k3y-0f-the-test";
const TOKEN = "t0ken-0f-the-test";
const AUTH = `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`;

const BOARD = "5f0000000000000000000b01";
const OTHER_BOARD = "5f0000000000000000000b02";
const OPEN = "5f00000000000000000001a1";
const DOING = "5f00000000000000000001a2";
const ARCHIVED = "5f00000000000000000001a3";
const FIX = "5f00000000000000000001b1";
const CARD = "5f5f5f5f0000000000000c01";
const CARD_2 = "5f5f5f5f0000000000000c02";
const CARD_3 = "5f5f5f5f0000000000000c03";
const FOREIGN = "5f5f5f5f0000000000000c99";
const GONE = "5f5f5f5f000000000000dead";

interface FakeCard {
  id: string;
  idBoard: string;
  idShort: number;
  shortLink: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
}

interface FakeAction {
  id: string;
  idCard: string;
  text: string;
  date: string;
}

/** A small in-memory Trello: one board, its lists, labels, cards and comments. */
class FakeTrello {
  lists = [
    { id: OPEN, name: "Open", closed: false, pos: 1 },
    { id: DOING, name: "In progress", closed: false, pos: 2 },
    { id: ARCHIVED, name: "Shipped", closed: true, pos: 3 },
  ];
  labels = [
    { id: FIX, name: "fix" },
    { id: "5f00000000000000000001b2", name: "" },
  ];
  cards: FakeCard[] = [
    this.card(CARD, 1, "c1Short1", "Fix it"),
    this.card(CARD_2, 2, "c2Short2", "Second"),
    this.card(CARD_3, 3, "c3Short3", "Third"),
    { ...this.card(FOREIGN, 9, "fOreign9", "Elsewhere"), idBoard: OTHER_BOARD },
  ];
  actions: FakeAction[] = [];
  requests: { method: string; url: URL; auth: string | null; body: unknown }[] =
    [];
  boardStatus = 200;
  overrides: ((req: Request, url: URL) => Response | undefined)[] = [];

  card(id: string, n: number, shortLink: string, name: string): FakeCard {
    return {
      id,
      idBoard: BOARD,
      idShort: n,
      shortLink,
      name,
      desc: "",
      idList: OPEN,
      idLabels: [FIX],
    };
  }

  comment(idCard: string, n: number) {
    const id = `5f5f5f5f00000000000a${String(n).padStart(4, "0")}`;
    this.actions.push({
      id,
      idCard,
      text: `comment ${n}`,
      date: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
    });
    return id;
  }

  view(card: FakeCard) {
    return {
      ...card,
      shortUrl: `https://trello.com/c/${card.shortLink}`,
      dateLastActivity: "2026-10-20T10:00:00.000Z",
    };
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const text = req.body ? await req.text() : "";
    const body = text ? JSON.parse(text) : undefined;
    this.requests.push({
      method: req.method,
      url,
      auth: req.headers.get("authorization"),
      body,
    });
    for (const override of this.overrides) {
      const answer = override(req, url);
      if (answer !== undefined) return answer;
    }
    if (req.headers.get("authorization") !== AUTH) {
      return new Response("invalid key", { status: 401 });
    }
    const path = url.pathname.replace(/^\/1/, "");
    const found = (card: FakeCard | undefined) =>
      card === undefined
        ? new Response("The requested resource was not found.", {
          status: 404,
        })
        : Response.json(this.view(card));
    let m: RegExpExecArray | null;
    if ((m = /^\/boards\/([^/]+)$/.exec(path))) {
      if (this.boardStatus !== 200) {
        return new Response("board not found", { status: this.boardStatus });
      }
      return [BOARD, "brdShort"].includes(m[1])
        ? Response.json({ id: BOARD, name: "Tickets" })
        : new Response("invalid id", { status: 400 });
    }
    if ((m = /^\/boards\/[^/]+\/lists$/.exec(path))) {
      const open = url.searchParams.get("filter") === "open";
      return Response.json(this.lists.filter((l) => !open || !l.closed));
    }
    if (/^\/boards\/[^/]+\/labels$/.test(path)) {
      return Response.json(this.labels);
    }
    if ((m = /^\/boards\/[^/]+\/cards\/(\d+)$/.exec(path))) {
      return found(
        this.cards.find((c) =>
          c.idBoard === BOARD && c.idShort === Number(m![1])
        ),
      );
    }
    if ((m = /^\/lists\/([^/]+)$/.exec(path))) {
      const list = this.lists.find((l) => l.id === m![1]);
      return list ? Response.json(list) : new Response("", { status: 404 });
    }
    if ((m = /^\/cards\/([^/]+)\/actions\/comments$/.exec(path))) {
      const card = this.cards.find((c) => c.id === m![1]);
      if (!card) return found(undefined);
      const id = this.comment(card.id, this.actions.length + 1);
      this.actions[this.actions.length - 1].text = body.text;
      return Response.json({ id });
    }
    if ((m = /^\/cards\/([^/]+)\/actions$/.exec(path))) {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      const newestFirst = this.actions
        .filter((a) => a.idCard === m![1])
        .filter((a) => before === null || a.id < before)
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, limit);
      return Response.json(newestFirst.map((a) => ({
        id: a.id,
        type: "commentCard",
        date: a.date,
        data: { text: a.text },
        memberCreator: { username: "zts" },
      })));
    }
    if ((m = /^\/cards\/([^/]+)$/.exec(path))) {
      if (!/^([0-9a-f]{24}|[A-Za-z0-9]{8})$/.test(m[1])) {
        return new Response("invalid id", { status: 400 });
      }
      const card = this.cards.find((c) =>
        c.id === m![1] || c.shortLink === m![1]
      );
      if (req.method === "PUT" && card) {
        card.idList = body.idList;
      }
      return found(card);
    }
    if (path === "/cards" && req.method === "POST") {
      const card = this.card(
        `5f5f5f5f0000000000000d${String(this.cards.length).padStart(2, "0")}`,
        this.cards.length + 1,
        `new${this.cards.length}Shrt`.slice(0, 8),
        body.name,
      );
      card.desc = body.desc;
      card.idList = body.idList;
      card.idLabels = body.idLabels;
      this.cards.push(card);
      return Response.json(this.view(card));
    }
    return new Response(`no route ${req.method} ${path}`, { status: 500 });
  };
}

function tracker(stored: Record<string, Record<string, unknown>> = {}) {
  const testContext = createModelTestContext({
    globalArgs: { boardId: BOARD, prefix: "trello", apiKey: KEY, token: TOKEN },
    methodName: "operate",
    storedResources: stored,
  });
  let n = 0;
  const operate = async (operation: string, request: unknown) => {
    const answer = `answer-test-${++n}`;
    await behavior.methods.operate.execute(
      { operation, request, answer, run: "run-1" } as never,
      testContext.context as never,
    );
    const written = testContext.getWrittenResources().filter((w) =>
      w.name === answer
    );
    assertEquals(written.length, 1, `one answer for ${operation}`);
    behavior.resources.answer.schema.parse(written[0].data);
    return written[0].data as Record<string, unknown>;
  };
  return { ...testContext, operate };
}

async function run<T>(fake: FakeTrello, fn: () => Promise<T>): Promise<T> {
  const { result } = await withMockedFetch(fake.handle, fn);
  return result;
}

// --- describe ---------------------------------------------------------------

Deno.test("describe records the tracker for stagecraft", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { boardId: BOARD, prefix: "trello", apiKey: KEY, token: TOKEN },
    methodName: "describe",
  });
  await behavior.methods.describe.execute({} as never, context as never);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "description");
  assertEquals(written.name, "description");
  assertEquals(written.data, {
    tracker: "trello",
    contract: 1,
    origin: "snapshot",
    capabilities: { history: false, assign: false, pullRequests: false },
    closesDuplicates: false,
  });
  const schema = behavior.resources.description.schema;
  assertEquals(schema.safeParse(written.data).success, true);
  assertEquals(schema.safeParse({ tracker: "trello" }).success, false);
  assertEquals(
    schema.safeParse({ ...written.data, extra: true }).success,
    false,
  );
});

// --- fetch_issue --------------------------------------------------------------

Deno.test("fetch_issue finds a card by id, shortLink and display id", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  for (const ref of [CARD, "c1Short1", "trello-1", "TRELLO-1"]) {
    const answer = await run(
      fake,
      () => operate("fetch_issue", { issue: ref }),
    );
    assertEquals(answer.ok, true, ref);
    const ticket = answer.result as Record<string, unknown>;
    assertEquals(ticket.id, CARD);
    assertEquals(ticket.display, "trello-1");
    assertEquals(ticket.title, "Fix it");
    assertEquals(ticket.url, "https://trello.com/c/c1Short1");
    assertEquals(ticket.status, { id: OPEN, name: "Open" });
    assertEquals(ticket.labels, ["fix"]);
    assertEquals(ticket.relations, []);
    assertEquals(ticket.createdAt, new Date(0x5f5f5f5f * 1000).toISOString());
  }
});

Deno.test("fetch_issue returns every comment, oldest first, across pages", async () => {
  const fake = new FakeTrello();
  for (let i = 1; i <= 1003; i++) fake.comment(CARD, i);
  const { operate } = tracker();
  const answer = await run(fake, () => operate("fetch_issue", { issue: CARD }));
  const activity = (answer.result as { activity: { body: string }[] })
    .activity;
  assertEquals(activity.length, 1003);
  assertEquals(activity[0].body, "comment 1");
  assertEquals(activity[1002].body, "comment 1003");
  const pages = fake.requests.filter((r) =>
    r.url.pathname.endsWith("/actions")
  );
  assertEquals(pages.length, 2);
  assertEquals(pages[0].url.searchParams.get("limit"), "1000");
  assertExists(pages[1].url.searchParams.get("before"));
});

/** Every operation that resolves an issue, with the rest of its request. */
const onIssue: [string, Record<string, unknown>][] = [
  ["fetch_issue", {}],
  ["comment", { body: "hi" }],
  ["set_status", { status: "In progress" }],
  ["relate", { type: "related_to", to: CARD_2 }],
];

for (
  const [what, ref] of [
    ["a card on another board", FOREIGN],
    ["a malformed id", "not-a-card"],
    ["a card Trello answers 400 for", "zzzzzzzzzzzzzzzzzzzzzzzz"],
    ["an unknown display id", "trello-999999"],
    ["an unknown shortLink", "nOsuchCd"],
  ]
) {
  for (const [op, rest] of onIssue) {
    Deno.test(`${op} reports not_found for ${what}`, async () => {
      const fake = new FakeTrello();
      const { operate, getWrittenResources } = tracker();
      const answer = await run(
        fake,
        () => operate(op, { issue: ref, ...rest }),
      );
      assertEquals(answer.ok, false);
      assertEquals(answer.kind, "not_found");
      assertEquals(getWrittenResources().length, 1);
      assertEquals(fake.requests.some((r) => r.method !== "GET"), false);
    });
  }
}

Deno.test("a 401 on the card after the board read is not_found", async () => {
  const fake = new FakeTrello();
  fake.overrides.push((req, url) =>
    req.method === "GET" && url.pathname === `/1/cards/${CARD}`
      ? new Response("unauthorized card permission requested", { status: 401 })
      : undefined
  );
  const { operate } = tracker();
  for (const [op, rest] of onIssue) {
    const answer = await run(
      fake,
      () => operate(op, { issue: CARD, ...rest }),
    );
    assertEquals(answer.kind, "not_found", op);
  }
  assertEquals(fake.requests.some((r) => r.method !== "GET"), false);
});

Deno.test("comment and set_status never touch a card on another board", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const comment = await run(
    fake,
    () => operate("comment", { issue: FOREIGN, body: "hi" }),
  );
  const move = await run(
    fake,
    () => operate("set_status", { issue: FOREIGN, status: "In progress" }),
  );
  assertEquals(comment.kind, "not_found");
  assertEquals(move.kind, "not_found");
  assertEquals(fake.actions.length, 0);
  assertEquals(fake.cards.find((c) => c.id === FOREIGN)!.idList, OPEN);
});

// --- board and credentials -----------------------------------------------------

Deno.test("refused credentials are auth", async () => {
  const fake = new FakeTrello();
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      boardId: BOARD,
      prefix: "trello",
      apiKey: "wrong",
      token: TOKEN,
    },
    methodName: "operate",
  });
  await run(fake, () =>
    behavior.methods.operate.execute(
      {
        operation: "fetch_issue",
        request: { issue: CARD },
        answer: "answer-a",
      } as never,
      context as never,
    ));
  assertEquals(getWrittenResources()[0].data.kind, "auth");
});

for (const status of [400, 404]) {
  Deno.test(`a ${status} on the board is upstream, not not_found`, async () => {
    const fake = new FakeTrello();
    fake.boardStatus = status;
    const { operate } = tracker();
    const answer = await run(
      fake,
      () => operate("fetch_issue", { issue: CARD }),
    );
    assertEquals(answer.kind, "upstream");
    assertEquals(String(answer.detail).includes(BOARD), true);
  });
}

Deno.test("credentials go in the OAuth header and nowhere else", async () => {
  const fake = new FakeTrello();
  fake.overrides.push((_req, url) =>
    url.pathname.endsWith("/actions/comments")
      ? new Response("boom", { status: 500 })
      : undefined
  );
  const { operate, getWrittenResources, getLogs } = tracker();
  await run(fake, () => operate("fetch_issue", { issue: CARD }));
  await run(fake, () => operate("comment", { issue: CARD, body: "x" }));
  for (const r of fake.requests) {
    assertEquals(r.auth, AUTH);
    assertEquals(r.url.href.includes(KEY) || r.url.href.includes(TOKEN), false);
  }
  const written = JSON.stringify(getWrittenResources());
  const logs = JSON.stringify(getLogs());
  for (const secret of [KEY, TOKEN]) {
    assertEquals(written.includes(secret), false);
    assertEquals(logs.includes(secret), false);
  }
});

Deno.test("a 429 is rate_limited with Retry-After in the detail", async () => {
  const fake = new FakeTrello();
  fake.overrides.push(() =>
    new Response("API_TOKEN_LIMIT_EXCEEDED", {
      status: 429,
      headers: { "Retry-After": "10" },
    })
  );
  const { operate } = tracker();
  const answer = await run(fake, () => operate("fetch_issue", { issue: CARD }));
  assertEquals(answer.kind, "rate_limited");
  assertEquals(String(answer.detail).includes("Retry-After: 10"), true);
});

Deno.test("a 500 is upstream", async () => {
  const fake = new FakeTrello();
  fake.overrides.push((_req, url) =>
    url.pathname.endsWith("/lists")
      ? new Response("", { status: 500 })
      : undefined
  );
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("set_status", { issue: CARD, status: "Open" }),
  );
  assertEquals(answer.kind, "upstream");
});

// --- create, comment, set_status ----------------------------------------------

Deno.test("create puts a labelled card on the first open list", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("create", { title: "New", body: "Body", type: "fix" }),
  );
  assertEquals(answer.ok, true);
  const ticket = answer.result as Record<string, unknown>;
  assertEquals(ticket.title, "New");
  assertEquals(ticket.description, "Body");
  assertEquals(ticket.status, { id: OPEN, name: "Open" });
  assertEquals(ticket.labels, ["fix"]);
  assertEquals(ticket.display, "trello-5");
  const post = fake.requests.find((r) => r.method === "POST")!;
  assertEquals(post.body, {
    idList: OPEN,
    name: "New",
    desc: "Body",
    idLabels: [FIX],
    pos: "bottom",
  });
});

Deno.test("create refuses a type with no label, naming the labels", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("create", { title: "New", body: "", type: "bug" }),
  );
  assertEquals(answer.kind, "invalid");
  assertEquals(answer.detail, "no label 'bug' on the board: fix");
});

Deno.test("comment posts and returns the action id", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("comment", { issue: "trello-1", body: "**hello**" }),
  );
  assertEquals(answer.ok, true);
  const result = answer.result as { id: string; url: string };
  assertEquals(result.id, fake.actions[0].id);
  assertEquals(fake.actions[0].text, "**hello**");
  assertEquals(
    result.url,
    `https://trello.com/c/c1Short1#comment-${result.id}`,
  );
});

Deno.test("text over Trello's limit is invalid, before any request", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const long = "x".repeat(TEXT_LIMIT + 1);
  const comment = await run(
    fake,
    () => operate("comment", { issue: CARD, body: long }),
  );
  const create = await run(
    fake,
    () => operate("create", { title: "t", body: long, type: "fix" }),
  );
  assertEquals(comment.kind, "invalid");
  assertEquals(create.kind, "invalid");
  assertEquals(String(comment.detail).includes("16384"), true);
  assertEquals(fake.requests.length, 0);
});

Deno.test("set_status moves the card, and reports no change when it is there", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const moved = await run(
    fake,
    () => operate("set_status", { issue: CARD, status: "In progress" }),
  );
  assertEquals(moved.result, {
    changed: true,
    status: { id: DOING, name: "In progress" },
  });
  assertEquals(fake.cards[0].idList, DOING);
  const again = await run(
    fake,
    () => operate("set_status", { issue: CARD, status: "In progress" }),
  );
  assertEquals((again.result as { changed: boolean }).changed, false);
});

Deno.test("set_status ignores archived lists and names the open ones", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("set_status", { issue: CARD, status: "Shipped" }),
  );
  assertEquals(answer.kind, "invalid");
  assertEquals(answer.detail, "no open list 'Shipped': Open, In progress");
});

Deno.test("duplicate list or label names are refused", async () => {
  const fake = new FakeTrello();
  fake.lists.push({
    id: "5f00000000000000000001a9",
    name: "Open",
    closed: false,
    pos: 9,
  });
  fake.labels.push({ id: "5f00000000000000000001b9", name: "fix" });
  const { operate } = tracker();
  const move = await run(
    fake,
    () => operate("set_status", { issue: CARD, status: "Open" }),
  );
  const create = await run(
    fake,
    () => operate("create", { title: "t", body: "", type: "fix" }),
  );
  assertEquals(move.kind, "invalid");
  assertEquals(String(move.detail).includes("more than one open list"), true);
  assertEquals(create.kind, "invalid");
  assertEquals(String(create.detail).includes("more than one label"), true);
});

// --- the retry rules ----------------------------------------------------------

Deno.test("an answer that succeeded is never made again", async () => {
  const fake = new FakeTrello();
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { boardId: BOARD, prefix: "trello", apiKey: KEY, token: TOKEN },
    methodName: "operate",
    storedResources: { "answer-done": { ok: true, result: { id: "x" } } },
  });
  await run(fake, () =>
    behavior.methods.operate.execute(
      {
        operation: "comment",
        request: { issue: CARD, body: "again" },
        answer: "answer-done",
      } as never,
      context as never,
    ));
  assertEquals(fake.requests.length, 0);
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("a failure writes only its answer, with the run", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker();
  const answer = await run(
    fake,
    () => operate("relate", { issue: CARD, type: "parent_of", to: CARD }),
  );
  assertEquals(answer.run, "run-1");
  assertEquals(answer.kind, "invalid");
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("a request that is not JSON is an invalid answer", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(fake, () => operate("comment", "{not json"));
  assertEquals(answer.kind, "invalid");
});

for (const request of ["null", "3", '"text"', "[]", '[{"issue":"x"}]']) {
  Deno.test(`a request of ${request} is an invalid answer`, async () => {
    const fake = new FakeTrello();
    const { operate } = tracker();
    const answer = await run(fake, () => operate("fetch_issue", request));
    assertEquals(answer.kind, "invalid");
    assertEquals(answer.detail, "the request is not a JSON object");
    assertEquals(fake.requests.length, 0);
  });
}

Deno.test("an operation the tracker does not offer is invalid", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("post_entry", { issue: CARD, entry: {} }),
  );
  assertEquals(answer.kind, "invalid");
});

Deno.test("the answer schema holds a result or a failure, not both or neither", () => {
  const schema = behavior.resources.answer.schema;
  const ok = { operation: "comment", ok: true, result: { id: "a" } };
  const failed = {
    operation: "comment",
    run: "run-1",
    ok: false,
    kind: "not_found",
    detail: "no ticket",
  };
  assertEquals(schema.safeParse(ok).success, true);
  assertEquals(schema.safeParse(failed).success, true);
  assertEquals(schema.safeParse({ ...ok, result: undefined }).success, false);
  assertEquals(schema.safeParse({ ...failed, kind: "oops" }).success, false);
  assertEquals(schema.safeParse({ ...ok, kind: "auth" }).success, false);
});

// --- relations ----------------------------------------------------------------

function relationsOf(
  written: { name: string; data: Record<string, unknown> }[],
  card: string,
) {
  const last = written.filter((w) => w.name === `relations-${card}`).at(-1);
  return (last?.data.relations ?? []) as {
    type: string;
    direction: string;
    issue: string;
    display: string;
  }[];
}

Deno.test("relate writes both sides and fetch_issue reports them", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker();
  const answer = await run(
    fake,
    () => operate("relate", { issue: CARD, type: "parent_of", to: CARD_2 }),
  );
  assertEquals(answer.result, { changed: true });
  assertEquals(relationsOf(getWrittenResources(), CARD), [
    {
      type: "parent_of",
      direction: "outgoing",
      issue: CARD_2,
      display: "trello-2",
    },
  ]);
  assertEquals(relationsOf(getWrittenResources(), CARD_2), [
    {
      type: "parent_of",
      direction: "incoming",
      issue: CARD,
      display: "trello-1",
    },
  ]);
});

Deno.test("relating what is related reports no change", async () => {
  const fake = new FakeTrello();
  const stored = {
    [`relations-${CARD}`]: {
      card: CARD,
      relations: [{
        type: "related_to",
        direction: "outgoing",
        issue: CARD_2,
        display: "trello-2",
      }],
    },
    [`relations-${CARD_2}`]: {
      card: CARD_2,
      relations: [{
        type: "related_to",
        direction: "incoming",
        issue: CARD,
        display: "trello-1",
      }],
    },
  };
  const { operate } = tracker(stored);
  const answer = await run(
    fake,
    () => operate("relate", { issue: CARD, type: "related_to", to: CARD_2 }),
  );
  assertEquals(answer.result, { changed: false });
});

Deno.test("a half-written relation is completed on retry", async () => {
  const fake = new FakeTrello();
  const stored = {
    [`relations-${CARD}`]: {
      card: CARD,
      relations: [{
        type: "parent_of",
        direction: "outgoing",
        issue: CARD_2,
        display: "trello-2",
      }],
    },
  };
  const { operate, getWrittenResources } = tracker(stored);
  const answer = await run(
    fake,
    () => operate("relate", { issue: CARD, type: "parent_of", to: CARD_2 }),
  );
  assertEquals(answer.result, { changed: true });
  assertEquals(relationsOf(getWrittenResources(), CARD_2).length, 1);
  assertEquals(
    getWrittenResources().some((w) => w.name === `relations-${CARD}`),
    false,
  );
});

Deno.test("a half-removed relation is finished on retry", async () => {
  const fake = new FakeTrello();
  const stored = {
    [`relations-${CARD_2}`]: {
      card: CARD_2,
      relations: [{
        type: "blocked_by",
        direction: "incoming",
        issue: CARD,
        display: "trello-1",
      }],
    },
  };
  const { operate, getWrittenResources } = tracker(stored);
  const answer = await run(
    fake,
    () => operate("unrelate", { issue: CARD, type: "blocked_by", to: CARD_2 }),
  );
  assertEquals(answer.result, { changed: true });
  assertEquals(relationsOf(getWrittenResources(), CARD_2), []);
});

Deno.test("unrelating what is not related reports no change", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker();
  const answer = await run(
    fake,
    () => operate("unrelate", { issue: CARD, type: "related_to", to: CARD_2 }),
  );
  assertEquals(answer.result, { changed: false });
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("fetch_issue keeps the stored display of a related card that is gone", async () => {
  const fake = new FakeTrello();
  const stored = {
    [`relations-${CARD}`]: {
      card: CARD,
      relations: [{
        type: "related_to",
        direction: "outgoing",
        issue: GONE,
        display: "trello-77",
      }],
    },
  };
  const { operate } = tracker(stored);
  const answer = await run(fake, () => operate("fetch_issue", { issue: CARD }));
  assertEquals(answer.ok, true);
  assertEquals(
    (answer.result as { relations: { display: string }[] }).relations[0]
      .display,
    "trello-77",
  );
});

for (const [what, to] of [["id", GONE], ["display id", "TRELLO-77"]]) {
  Deno.test(`unrelate removes a relation to a gone card by its ${what}`, async () => {
    const fake = new FakeTrello();
    const { operate, getWrittenResources } = tracker({
      [`relations-${CARD}`]: {
        card: CARD,
        relations: [
          {
            type: "related_to",
            direction: "outgoing",
            issue: GONE,
            display: "trello-77",
          },
          {
            type: "blocked_by",
            direction: "outgoing",
            issue: GONE,
            display: "trello-77",
          },
        ],
      },
    });
    const answer = await run(
      fake,
      () => operate("unrelate", { issue: CARD, type: "related_to", to }),
    );
    assertEquals(answer.result, { changed: true });
    assertEquals(relationsOf(getWrittenResources(), CARD), [{
      type: "blocked_by",
      direction: "outgoing",
      issue: GONE,
      display: "trello-77",
    }]);
  });
}

for (const [what, issue] of [["id", GONE], ["display id", "trello-77"]]) {
  Deno.test(`unrelate removes a relation from a gone card by its ${what}`, async () => {
    const fake = new FakeTrello();
    const { operate, getWrittenResources } = tracker({
      [`relations-${CARD_2}`]: {
        card: CARD_2,
        relations: [{
          type: "parent_of",
          direction: "incoming",
          issue: GONE,
          display: "trello-77",
        }],
      },
    });
    const answer = await run(
      fake,
      () => operate("unrelate", { issue, type: "parent_of", to: CARD_2 }),
    );
    assertEquals(answer.result, { changed: true });
    assertEquals(relationsOf(getWrittenResources(), CARD_2), []);
    // The orphaned child can take a new parent again.
    const relate = await run(
      fake,
      () => operate("relate", { issue: CARD, type: "parent_of", to: CARD_2 }),
    );
    assertEquals(relate.result, { changed: true });
  });
}

Deno.test("unrelate between two gone cards is not_found", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker();
  const answer = await run(
    fake,
    () =>
      operate("unrelate", { issue: GONE, type: "related_to", to: "trello-78" }),
  );
  assertEquals(answer.kind, "not_found");
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("unrelate from a gone card it holds no relation to is not_found", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker();
  const answer = await run(
    fake,
    () => operate("unrelate", { issue: CARD, type: "related_to", to: GONE }),
  );
  assertEquals(answer.kind, "not_found");
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("unrelate removes a relation to a card moved off the board", async () => {
  const fake = new FakeTrello();
  const { operate, getWrittenResources } = tracker({
    [`relations-${CARD}`]: {
      card: CARD,
      relations: [{
        type: "related_to",
        direction: "outgoing",
        issue: FOREIGN,
        display: "trello-9",
      }],
    },
  });
  const answer = await run(
    fake,
    () => operate("unrelate", { issue: CARD, type: "related_to", to: FOREIGN }),
  );
  assertEquals(answer.result, { changed: true });
  assertEquals(relationsOf(getWrittenResources(), CARD), []);
});

const refusals: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["a self-relation", {}, { issue: CARD, type: "related_to", to: CARD }],
  [
    "a second parent",
    {
      [`relations-${CARD_3}`]: {
        card: CARD_3,
        relations: [{
          type: "parent_of",
          direction: "incoming",
          issue: CARD_2,
          display: "trello-2",
        }],
      },
    },
    { issue: CARD, type: "parent_of", to: CARD_3 },
  ],
  [
    "a parent loop",
    {
      [`relations-${CARD}`]: {
        card: CARD,
        relations: [{
          type: "parent_of",
          direction: "incoming",
          issue: CARD_2,
          display: "trello-2",
        }],
      },
      [`relations-${CARD_2}`]: {
        card: CARD_2,
        relations: [{
          type: "parent_of",
          direction: "outgoing",
          issue: CARD,
          display: "trello-1",
        }],
      },
    },
    { issue: CARD, type: "parent_of", to: CARD_2 },
  ],
  [
    "a second duplicate target",
    {
      [`relations-${CARD}`]: {
        card: CARD,
        relations: [{
          type: "duplicate_of",
          direction: "outgoing",
          issue: CARD_3,
          display: "trello-3",
        }],
      },
    },
    { issue: CARD, type: "duplicate_of", to: CARD_2 },
  ],
  [
    "a duplicate of a duplicate",
    {
      [`relations-${CARD_2}`]: {
        card: CARD_2,
        relations: [{
          type: "duplicate_of",
          direction: "outgoing",
          issue: CARD_3,
          display: "trello-3",
        }],
      },
    },
    { issue: CARD, type: "duplicate_of", to: CARD_2 },
  ],
  [
    "a ticket with duplicates becoming one",
    {
      [`relations-${CARD}`]: {
        card: CARD,
        relations: [{
          type: "duplicate_of",
          direction: "incoming",
          issue: CARD_3,
          display: "trello-3",
        }],
      },
    },
    { issue: CARD, type: "duplicate_of", to: CARD_2 },
  ],
  ["an unknown relation type", {}, {
    issue: CARD,
    type: "child_of",
    to: CARD_2,
  }],
];

for (const [what, stored, request] of refusals) {
  Deno.test(`relate refuses ${what}, writing nothing`, async () => {
    const fake = new FakeTrello();
    const { operate, getWrittenResources } = tracker(
      stored as Record<string, Record<string, unknown>>,
    );
    const answer = await run(fake, () => operate("relate", request));
    assertEquals(answer.ok, false);
    assertEquals(answer.kind, "invalid");
    assertEquals(getWrittenResources().length, 1);
  });
}

Deno.test("relate reports not_found for a card on another board", async () => {
  const fake = new FakeTrello();
  const { operate } = tracker();
  const answer = await run(
    fake,
    () => operate("relate", { issue: CARD, type: "related_to", to: FOREIGN }),
  );
  assertEquals(answer.kind, "not_found");
});
