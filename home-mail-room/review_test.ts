import { assertEquals } from "jsr:@std/assert@1.0.19";
import { handler } from "./review.ts";
import { PAGE_HTML } from "./review_page.ts";
import { type Decision, type Letter, Store } from "./review_store.ts";

const NAME = "letter-0123456789abcdef";

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
  });
  const get = (path: string) => handle(new Request(`http://x${path}`));
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`http://x${path}`, {
        method: "POST",
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
    new Request(`http://x/api/letters/${NAME}/decide`, {
      method: "POST",
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
