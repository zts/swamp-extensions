import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { type Decision, type Letter, Store } from "./review_store.ts";

function held(name: string): Letter {
  return {
    name,
    state: "held",
    pdfPath: `/Inbound/ReadyToFile/${name}.pdf`,
    cabinetDir: "/FileCabinet",
    proposal: {
      sender: "Thames Water",
      date: "2023-05-18",
      documentType: "bill",
      title: "",
    },
    reasons: ["No FileCabinet folder for the sender"],
  };
}

/** A store over a fake swamp whose outcomes the test controls. */
function setup(letters: Letter[]) {
  const calls: string[][] = [];
  const swamp = {
    letters: new Map(letters.map((l) => [l.name, l])),
    fail: undefined as string | undefined,
    /** What a decision leaves a letter as, in place of filed or skipped. */
    outcome: new Map<string, Partial<Letter>>(),
  };
  const store = new Store(
    (decisions: Decision[]) => {
      calls.push(decisions.map((d) => `${d.action} ${d.letter}`));
      if (swamp.fail) return Promise.reject(new Error(swamp.fail));
      for (const d of decisions) {
        const l = swamp.letters.get(d.letter)!;
        swamp.letters.set(d.letter, {
          ...l,
          state: d.action === "file" ? "filed" : "skipped",
          ...swamp.outcome.get(d.letter),
        });
      }
      return Promise.resolve();
    },
    (names) =>
      Promise.resolve(
        [...swamp.letters.values()].filter((l) =>
          !names || names.includes(l.name)
        ),
      ),
  );
  return { store, calls, swamp };
}

const find = (store: Store, name: string) =>
  store.letters().find((l) => l.name === name)!;

Deno.test("a decision shows at once, and settles once swamp has applied it", async () => {
  const { store } = setup([held("a")]);
  await store.refresh();
  store.act("a", { action: "file" });
  assertEquals(find(store, "a").state, "filed");
  assertEquals(find(store, "a").sync, "saving");
  await store.idle();
  assertEquals(find(store, "a").state, "filed");
  assertEquals(find(store, "a").sync, undefined);
});

Deno.test("decisions made together go to swamp as one run", async () => {
  const { store, calls } = setup([held("a"), held("b")]);
  await store.refresh();
  store.act("b", { action: "skip" });
  store.act("a", { action: "file", title: "Water" });
  await store.idle();
  assertEquals(calls, [["skip b", "file a"]]);
});

Deno.test("bulk decides every letter given, in one run", async () => {
  const { store, calls } = setup([held("a"), held("b"), held("c")]);
  await store.refresh();
  store.bulk(["a", "c"], { action: "file", sender: "Thames Water" });
  await store.idle();
  assertEquals(calls, [["file a", "file c"]]);
  assertEquals(find(store, "b").state, "held");
});

Deno.test("a letter swamp could not file comes back with the reason", async () => {
  const { store, swamp } = setup([held("a")]);
  await store.refresh();
  swamp.outcome.set("a", {
    state: "conflict",
    reasons: ["Another file is already at X"],
  });
  store.act("a", { action: "file" });
  await store.idle();
  assertEquals(find(store, "a").state, "conflict");
  assertEquals(find(store, "a").sync, "failed");
  assertEquals(find(store, "a").syncError, "Another file is already at X");
});

Deno.test("a failed swamp run puts every letter back with the error", async () => {
  const { store, swamp } = setup([held("a"), held("b")]);
  await store.refresh();
  swamp.fail = "swamp is not running";
  store.act("a", { action: "file" });
  store.act("b", { action: "skip" });
  await store.idle();
  for (const name of ["a", "b"]) {
    assertEquals(find(store, name).state, "held");
    assertEquals(find(store, name).sync, "failed");
    assertEquals(find(store, name).syncError, "swamp is not running");
  }
});

Deno.test("fields swamp would refuse are refused without calling it", async () => {
  const { store, calls } = setup([held("a")]);
  await store.refresh();
  assertThrows(() => store.act("a", { action: "file", date: "18/05/2023" }));
  assertThrows(() => store.act("a", { action: "file", sender: " " }));
  assertThrows(() => store.act("a", { action: "file", documentType: "x" }));
  assertThrows(() => store.act("a", { action: "file", filename: "a/b.pdf" }));
  await store.idle();
  assertEquals(calls, []);
});

Deno.test("a letter already decided is refused", async () => {
  const { store } = setup([held("a")]);
  await store.refresh();
  store.act("a", { action: "skip" });
  assertThrows(() => store.act("a", { action: "file" }), Error, "skipped");
});

Deno.test("a refresh keeps decisions swamp has not applied", async () => {
  const { store } = setup([held("a")]);
  await store.refresh();
  store.act("a", { action: "file" });
  await store.refresh();
  assertEquals(find(store, "a").state, "filed");
  assertEquals(find(store, "a").sync, "saving");
});
