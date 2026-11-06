import { assertEquals } from "jsr:@std/assert@1.0.19";
import { pageModule } from "./build.ts";

// Backticks, ${ and backslashes, as the page's own script has them.
const HTML = '<p class="a">it\'s</p>\n<script>\nconst u = `/api/${n}`;\n' +
  "const re = /\\d+/;\n</script>\n";

/** The PAGE_HTML a generated module exports. */
async function exported(source: string): Promise<string> {
  const url = `data:application/typescript;base64,${
    btoa(String.fromCharCode(...new TextEncoder().encode(source)))
  }`;
  return (await import(url)).PAGE_HTML;
}

Deno.test("the generated module exports the page exactly", async () => {
  assertEquals(await exported(pageModule(HTML)), HTML);
});

Deno.test("the module built from the page is already formatted", async () => {
  // swamp extension fmt must leave it alone, or a rebuild undoes fmt.
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const source = pageModule(html);
  // deno fmt --check exits 0 on stdin, so compare what it writes instead.
  const fmt = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext=ts", "-"],
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const writer = fmt.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { stdout } = await fmt.output();
  assertEquals(
    new TextDecoder().decode(stdout) === source,
    true,
    "fmt changes it",
  );
});
