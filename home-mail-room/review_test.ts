import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { behavior, handler } from "./review.ts";
import { PAGE_HTML } from "./review_page.ts";
import { type Decision, type Letter, Store } from "./review_store.ts";

const NAME = "letter-0123456789abcdef";
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;

function held(over: Partial<Letter> = {}): Letter {
  return {
    name: NAME,
    state: "held",
    pdfPath: "/nowhere.pdf",
    cabinetDir: "/Cabinet",
    proposal: {
      sender: "Thames Water",
      date: "2023-05-18",
      documentType: "bill",
      title: "",
    },
    reasons: ["No FileCabinet folder for the sender"],
    ...over,
  };
}

async function setup(letters: Letter[]) {
  const sent: Decision[][] = [];
  const store = new Store(
    (decisions) => {
      sent.push(decisions);
      return Promise.resolve();
    },
    () => Promise.resolve(letters),
  );
  await store.refresh();
  const renamed: [string[], string][] = [];
  const handle = handler(store, new Map(), (names, sender) => {
    renamed.push([names, sender]);
    return Promise.resolve();
  }, () => PORT);
  const get = (path: string, base = BASE) =>
    handle(new Request(`${base}${path}`));
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) =>
    handle(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  return { store, handle, get, post, sent, renamed };
}

Deno.test("the page served is the one in review/index.html", async () => {
  const html = await Deno.readTextFile(
    new URL("./review/index.html", import.meta.url),
  );
  assertEquals(PAGE_HTML === html, true, "run review/build.ts");
  const { get } = await setup([]);
  assertEquals(await (await get("/")).text(), html);
});

Deno.test("preview files into the letter's own cabinet", async () => {
  const { get } = await setup([held()]);
  const res = await get(
    `/api/preview?letter=${NAME}&sender=Thames+Water&date=2023-05-18&documentType=bill&title=`,
  );
  assertEquals(await res.json(), {
    path: "/Cabinet/Thames Water/2023-05-18 Thames Water bill.pdf",
    problem: null,
  });
});

Deno.test("preview gives no path for a date that is not real", async () => {
  const { get } = await setup([held()]);
  const res = await get(
    `/api/preview?letter=${NAME}&sender=Thames+Water&date=2023-02-30&documentType=bill`,
  );
  assertEquals((await res.json()).path, null);
});

Deno.test("a decision posted for a letter reaches the filer as skip", async () => {
  const { handle, store, sent } = await setup([held()]);
  const res = await handle(
    new Request(`${BASE}/api/letters/${NAME}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "skip" }),
    }),
  );
  assertEquals((await res.json()).state, "skipped");
  await store.idle();
  assertEquals(sent, [[{ letter: NAME, action: "skip" }]]);
});

Deno.test("the letter's PDF is served from wherever it is now", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/a.pdf`, "%PDF");
    const { get } = await setup([held({ archivedPath: `${dir}/a.pdf` })]);
    const res = await get(`/api/letters/${NAME}/pdf`);
    assertEquals([res.status, await res.text()], [200, "%PDF"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown letter is not found", async () => {
  const { get } = await setup([]);
  assertEquals((await get(`/api/letters/${NAME}/pdf`)).status, 404);
});

Deno.test("rename asks the filer to rename the letters' sender", async () => {
  const { post, renamed } = await setup([held()]);
  const res = await post("/api/rename", {
    names: [NAME],
    sender: "Thames Water Utilities",
  });
  assertEquals(res.status, 200);
  assertEquals(renamed, [[[NAME], "Thames Water Utilities"]]);
});

Deno.test("rename refuses an empty name without asking the filer", async () => {
  const { post, renamed } = await setup([held()]);
  const res = await post("/api/rename", { names: [NAME], sender: " " });
  assertEquals(res.status, 422);
  assertEquals(renamed, []);
});

Deno.test("the page answers at its own port on 127.0.0.1 and localhost", async () => {
  const { get } = await setup([held()]);
  assertEquals((await get("/")).status, 200);
  assertEquals(
    (await get("/api/letters", `http://localhost:${PORT}`)).status,
    200,
  );
});

Deno.test("a request for another host is refused, as DNS rebinding sends", async () => {
  const { get } = await setup([held()]);
  for (const base of [`http://evil.example:${PORT}`, "http://127.0.0.1:9999"]) {
    const res = await get("/api/letters", base);
    assertEquals(res.status, 403, base);
    assertEquals(JSON.stringify(await res.json()).includes("Thames"), false);
  }
});

Deno.test("a POST from another origin is refused before it reaches the filer", async () => {
  const { post, renamed } = await setup([held()]);
  for (
    const origin of ["http://evil.example", "null", `https://127.0.0.1:${PORT}`]
  ) {
    const res = await post(
      "/api/rename",
      { names: [NAME], sender: "Mallory" },
      {
        "content-type": "application/json",
        origin,
      },
    );
    assertEquals(res.status, 403, origin);
  }
  assertEquals(renamed, []);
});

Deno.test("a POST from the page's own origin is accepted", async () => {
  const { post, renamed } = await setup([held()]);
  const res = await post("/api/rename", { names: [NAME], sender: "Thames" }, {
    "content-type": "application/json",
    origin: `http://localhost:${PORT}`,
  });
  assertEquals(res.status, 200);
  assertEquals(renamed, [[[NAME], "Thames"]]);
});

Deno.test("serve on port 0 answers the page at the port it was given", async () => {
  const test = createModelTestContext({ globalArgs: {}, methodName: "serve" });
  const stop = new AbortController();
  let bound = 0;
  const listening = Promise.withResolvers<void>();
  const context = {
    ...test.context,
    signal: stop.signal,
    queryData: () => Promise.resolve([]),
    dataRepository: { getContent: () => Promise.resolve(null) },
    logger: {
      ...test.context.logger,
      info: (_message: string, props?: Record<string, unknown>) => {
        if (typeof props?.port === "number") bound = props.port;
        listening.resolve();
      },
    },
  };
  const served = behavior.methods.serve.execute({ port: 0 }, context);
  try {
    await listening.promise;
    const res = await fetch(`http://127.0.0.1:${bound}/api/letters`);
    assertEquals([res.status, await res.json()], [200, []]);
  } finally {
    stop.abort();
    await served;
  }
});

Deno.test("a POST that is not JSON is refused before it reaches the filer", async () => {
  const { post, renamed } = await setup([held()]);
  // A cross-origin form or text/plain POST needs no preflight.
  for (
    const headers of [
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "application/jsonx" },
      {} as Record<string, string>,
    ]
  ) {
    const res = await post(
      "/api/rename",
      { names: [NAME], sender: "Mallory" },
      headers,
    );
    assertEquals(res.status, 415, JSON.stringify(headers));
  }
  assertEquals(renamed, []);
});

Deno.test("a JSON POST is accepted whatever its case and parameters", async () => {
  const { post, renamed } = await setup([held()]);
  const res = await post("/api/rename", { names: [NAME], sender: "Thames" }, {
    "content-type": "Application/JSON ; charset=utf-8",
  });
  assertEquals(res.status, 200);
  assertEquals(renamed, [[[NAME], "Thames"]]);
});
