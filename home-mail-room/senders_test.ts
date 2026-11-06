import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { addSenderNames, readSenderNames, SENDERS_FILE } from "./senders.ts";

async function withCabinet(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "home-mail-room-senders-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a cabinet with no senders.yaml renames no one", async () => {
  await withCabinet(async (dir) => {
    assertEquals((await readSenderNames(dir)).size, 0);
  });
});

Deno.test("a rename matches the sender as read whatever its case or spacing", async () => {
  await withCabinet(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/${SENDERS_FILE}`,
      "# mine\n'The Dextrous Web Ltd, trading as dxw digital': dxw digital\n",
    );
    const names = await readSenderNames(dir);
    assertEquals(
      names.get("the dextrous web ltd, trading as dxw digital"),
      "dxw digital",
    );
  });
});

Deno.test("adding a rename keeps the others and replaces one for the same sender", async () => {
  await withCabinet(async (dir) => {
    await addSenderNames(dir, { "EDF ENERGY": "Edf", "HALIFAX": "Halifax" });
    await addSenderNames(dir, { "edf  energy": "EDF Energy" });
    const names = await readSenderNames(dir);
    assertEquals(Object.fromEntries(names), {
      "edf energy": "EDF Energy",
      "halifax": "Halifax",
    });
  });
});

Deno.test("a senders.yaml that is not a list of renames is an error", async () => {
  await withCabinet(async (dir) => {
    await Deno.writeTextFile(`${dir}/${SENDERS_FILE}`, "- just a list\n");
    await assertRejects(() => readSenderNames(dir), Error, SENDERS_FILE);
  });
});
