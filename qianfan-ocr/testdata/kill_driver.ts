// Runs extractBatch on one image, as swamp would, so a test can SIGKILL
// this process mid-batch. Arguments: the fake uv's path and the repo dir.
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { behavior } from "../qianfan_ocr.ts";

const [uvPath, repoDir] = Deno.args;
const test = createModelTestContext({
  globalArgs: { uvPath },
  methodName: "extractBatch",
  repoDir,
});
await behavior.methods.extractBatch.execute(
  { items: [{ imagePath: "scans/a.png", prompt: "Read a" }] },
  // deno-lint-ignore no-explicit-any
  { ...test.context, extensionFile: (path: string) => `/ext/${path}` } as any,
);
