import { assertEquals } from "jsr:@std/assert@1.0.19";
import { parse } from "jsr:@std/yaml@1.0.9";
import { behavior as filer } from "./filer.ts";
import { behavior as review } from "./review.ts";
import { behavior as scanner } from "./scanner.ts";

// Each behavior states its version in code, apart from the manifest, so a
// bump of one alone would ship behaviors that say they are another release.
Deno.test("each behavior's version is the manifest's", async () => {
  const manifest = parse(
    await Deno.readTextFile(new URL("./manifest.yaml", import.meta.url)),
  ) as { version: string };
  for (const b of [scanner, filer, review]) {
    assertEquals(b.version, manifest.version, b.type);
  }
});
