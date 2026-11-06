import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { contentHash, fileHash, moveInto, pdfsIn } from "./inbound.ts";

const enc = new TextEncoder();

async function withDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "home-mail-room-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("pdfsIn lists PDFs sorted with their hashes, ignoring other files", async () => {
  await withDir(async (dir) => {
    await Deno.writeFile(`${dir}/b.pdf`, enc.encode("b"));
    await Deno.writeFile(`${dir}/a.PDF`, enc.encode("a"));
    await Deno.writeFile(`${dir}/notes.txt`, enc.encode("x"));
    await Deno.mkdir(`${dir}/sub.pdf`);
    const pdfs = await pdfsIn(dir);
    assertEquals(pdfs, [
      { path: `${dir}/a.PDF`, hash: await contentHash(enc.encode("a")) },
      { path: `${dir}/b.pdf`, hash: await contentHash(enc.encode("b")) },
    ]);
  });
});

Deno.test("pdfsIn finds none in a missing folder and skips broken links", async () => {
  await withDir(async (dir) => {
    assertEquals(await pdfsIn(`${dir}/nope`), []);
    await Deno.symlink(`${dir}/gone.pdf`, `${dir}/link.pdf`);
    const warnings: unknown[] = [];
    assertEquals(await pdfsIn(dir, (_m, p) => warnings.push(p)), []);
    assertEquals(warnings, [{ path: `${dir}/link.pdf` }]);
  });
});

Deno.test("moveInto keeps the name, or prefixes the short hash when it is taken", async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/in`);
    await Deno.writeFile(`${dir}/in/x.pdf`, enc.encode("one"));
    const one = await contentHash(enc.encode("one"));
    assertEquals(
      await moveInto(`${dir}/out`, `${dir}/in/x.pdf`, one),
      `${dir}/out/x.pdf`,
    );

    await Deno.writeFile(`${dir}/in/x.pdf`, enc.encode("two"));
    const two = await contentHash(enc.encode("two"));
    assertEquals(
      await moveInto(`${dir}/out`, `${dir}/in/x.pdf`, two),
      `${dir}/out/${two.slice(0, 16)}-x.pdf`,
    );
    assertEquals(await fileHash(`${dir}/out/x.pdf`), one);
    assertEquals(await fileHash(`${dir}/in/x.pdf`), null);
  });
});

Deno.test("moveInto finishes a move an interrupted run made, removing the leftover copy", async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/in`);
    await Deno.mkdir(`${dir}/out`);
    await Deno.writeFile(`${dir}/in/x.pdf`, enc.encode("one"));
    await Deno.writeFile(`${dir}/out/x.pdf`, enc.encode("one"));
    const one = await contentHash(enc.encode("one"));
    assertEquals(
      await moveInto(`${dir}/out`, `${dir}/in/x.pdf`, one),
      `${dir}/out/x.pdf`,
    );
    assertEquals(await fileHash(`${dir}/in/x.pdf`), null);
  });
});

Deno.test("moveInto refuses when both names are taken by other files", async () => {
  await withDir(async (dir) => {
    await Deno.mkdir(`${dir}/in`);
    await Deno.mkdir(`${dir}/out`);
    const one = await contentHash(enc.encode("one"));
    await Deno.writeFile(`${dir}/in/x.pdf`, enc.encode("one"));
    await Deno.writeFile(`${dir}/out/x.pdf`, enc.encode("a"));
    await Deno.writeFile(
      `${dir}/out/${one.slice(0, 16)}-x.pdf`,
      enc.encode("b"),
    );
    await assertRejects(() => moveInto(`${dir}/out`, `${dir}/in/x.pdf`, one));
    assertEquals(await fileHash(`${dir}/in/x.pdf`), one);
  });
});
