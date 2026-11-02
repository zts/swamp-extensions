import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { decode } from "npm:fast-png@8.0.0";
import { renderTop, topRows } from "./render.ts";

const SAMPLE = await Deno.readFile(
  new URL("./testdata/sample-letter.pdf", import.meta.url),
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

Deno.test("renderTop renders the top of page 1 as a PNG of the size it reports", async () => {
  const top = await renderTop(SAMPLE, { page: 1, fraction: 0.25, dpi: 100 });
  assertEquals([...top.png.subarray(0, 8)], PNG_SIGNATURE);
  assertEquals(top.pageCount, 2);
  const image = decode(top.png);
  assertEquals([image.width, image.height], [top.width, top.height]);
  // A4 is 595 x 842 points; at 100 dpi a quarter of it is about 827 x 292.
  assertAlmostEquals(top.width, 595.28 * 100 / 72, 1);
  assertAlmostEquals(top.height, 841.89 * 100 / 72 * 0.25, 1);
});

Deno.test("renderTop scales the width with dpi and the height with fraction", async () => {
  const low = await renderTop(SAMPLE, { page: 1, fraction: 0.25, dpi: 100 });
  const high = await renderTop(SAMPLE, { page: 1, fraction: 0.25, dpi: 200 });
  const half = await renderTop(SAMPLE, { page: 1, fraction: 0.5, dpi: 100 });
  assertAlmostEquals(high.width, low.width * 2, 2);
  assertAlmostEquals(half.height, low.height * 2, 2);
  assertEquals(half.width, low.width);
});

Deno.test("renderTop renders the whole page when fraction is 1", async () => {
  const top = await renderTop(SAMPLE, { page: 1, fraction: 1, dpi: 72 });
  assertAlmostEquals(top.height, 842, 1);
});

Deno.test("renderTop renders the page asked for", async () => {
  const one = await renderTop(SAMPLE, { page: 1, fraction: 0.25, dpi: 72 });
  const two = await renderTop(SAMPLE, { page: 2, fraction: 0.25, dpi: 72 });
  assertEquals(two.width, one.width);
  // The letterhead is only on page 1, so the two images differ.
  assertNotEquals(one.png, two.png);
});

Deno.test("renderTop keeps at least one row of a tiny fraction", async () => {
  const top = await renderTop(SAMPLE, { page: 1, fraction: 0.0001, dpi: 50 });
  assertEquals(top.height, 1);
  assertEquals(decode(top.png).height, 1);
});

Deno.test("renderTop refuses a page outside the document", async () => {
  for (const page of [0, 3]) {
    const error = await assertRejects(() =>
      renderTop(SAMPLE, { page, fraction: 0.25, dpi: 72 })
    );
    assertStringIncludes(
      (error as Error).message,
      `page ${page} is out of range: the PDF has 2 pages`,
    );
  }
});

Deno.test("renderTop refuses a fraction outside (0, 1]", async () => {
  for (const fraction of [0, -0.5, 1.5, Number.NaN]) {
    const error = await assertRejects(() =>
      renderTop(SAMPLE, { page: 1, fraction, dpi: 72 })
    );
    assertStringIncludes((error as Error).message, "fraction must be");
  }
});

Deno.test("renderTop refuses a dpi outside 50-600", async () => {
  for (const dpi of [49, 601, 100.5]) {
    const error = await assertRejects(() =>
      renderTop(SAMPLE, { page: 1, fraction: 0.25, dpi })
    );
    assertStringIncludes((error as Error).message, "dpi must be");
  }
});

Deno.test("renderTop says when the bytes are not a readable PDF", async () => {
  const error = await assertRejects(() =>
    renderTop(new TextEncoder().encode("not a pdf"), {
      page: 1,
      fraction: 0.25,
      dpi: 72,
    })
  );
  assertStringIncludes((error as Error).message, "not a readable PDF");
});

Deno.test("topRows rounds to whole rows and never returns fewer than one", () => {
  assertEquals(topRows(1000, 0.25), 250);
  assertEquals(topRows(1000, 0.2504), 250);
  assertEquals(topRows(1000, 0.0001), 1);
  assertEquals(topRows(1000, 1), 1000);
});
