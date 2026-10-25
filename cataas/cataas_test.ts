import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261023.61";
import { behavior, fetchRandomCat } from "./cataas.ts";

const ENDPOINT = "https://cataas.com/cat?json=true";

const CAT = {
  id: "kGtGSL9LeRyo1AS3",
  tags: ["SWS"],
  created_at: "2024-06-17T09:17:52.803Z",
  url: "https://cataas.com/cat/kGtGSL9LeRyo1AS3?position=center",
  mimetype: "image/jpeg",
};

function runRandom(signal?: AbortSignal) {
  const testContext = createModelTestContext({ methodName: "random", signal });
  const run = () => behavior.methods.random.execute({}, testContext.context);
  return { ...testContext, run };
}

/** A fetch that never answers, and rejects with the reason once aborted. */
function hangUntilAborted(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (request.signal.aborted) return reject(request.signal.reason);
    request.signal.addEventListener(
      "abort",
      () => reject(request.signal.reason),
    );
  });
}

Deno.test("random writes one cat with every field", async () => {
  const { run, getWrittenResources } = runRandom();
  const { calls } = await withMockedFetch([Response.json(CAT)], run);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, ENDPOINT);
  assertEquals(calls[0].headers["accept"], "application/json");
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "cat");
  assertEquals(written[0].name, "random");
  assertEquals(written[0].data, {
    id: CAT.id,
    tags: CAT.tags,
    createdAt: CAT.created_at,
    url: CAT.url,
    mimetype: CAT.mimetype,
  });
});

Deno.test("random keeps an absolute URL, query string included", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch([Response.json(CAT)], run);

  assertEquals(getWrittenResources()[0].data.url, CAT.url);
});

Deno.test("random resolves a relative URL against cataas.com", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch(
    [Response.json({ ...CAT, url: "/cat/kGtGSL9LeRyo1AS3" })],
    run,
  );

  assertEquals(
    getWrittenResources()[0].data.url,
    "https://cataas.com/cat/kGtGSL9LeRyo1AS3",
  );
});

Deno.test("random ignores fields cataas adds later", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch([Response.json({ ...CAT, owner: "someone" })], run);

  assertEquals(getWrittenResources()[0].data.id, CAT.id);
  assertEquals("owner" in getWrittenResources()[0].data, false);
});

Deno.test("random throws on an HTTP error and writes nothing", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch([new Response("down", { status: 500 })], async () => {
    const error = await assertRejects(run, Error, "HTTP 500: down");
    assertEquals(error.message.includes("retry later"), false);
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random says a 429 is transient, with Retry-After", async () => {
  const { run, getWrittenResources } = runRandom();
  const limited = new Response("slow down", {
    status: 429,
    headers: { "Retry-After": "30" },
  });
  await withMockedFetch([limited], async () => {
    await assertRejects(
      run,
      Error,
      `cataas GET ${ENDPOINT} returned HTTP 429, a transient failure; ` +
        "retry later (Retry-After: 30): slow down",
    );
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random passes an HTTP-date Retry-After through as sent", async () => {
  const { run } = runRandom();
  const when = "Wed, 21 Oct 2026 07:28:00 GMT";
  const limited = new Response("", {
    status: 429,
    headers: { "Retry-After": when },
  });
  await withMockedFetch([limited], async () => {
    await assertRejects(run, Error, `(Retry-After: ${when})`);
  });
});

Deno.test("random says a 503 is transient, without Retry-After", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch([new Response("busy", { status: 503 })], async () => {
    const error = await assertRejects(
      run,
      Error,
      "HTTP 503, a transient failure; retry later: busy",
    );
    assertEquals(error.message.includes("Retry-After"), false);
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random names an image URL that cannot be parsed", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch(
    [Response.json({ ...CAT, url: "http://" })],
    async () => {
      await assertRejects(
        run,
        Error,
        `cataas GET ${ENDPOINT} returned an image URL that cannot be parsed: ` +
          "http://",
      );
    },
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random throws on a malformed body and writes nothing", async () => {
  const { run, getWrittenResources } = runRandom();
  const { id: _id, ...noId } = CAT;
  await withMockedFetch([Response.json(noId)], async () => {
    await assertRejects(run, Error, "unexpected body");
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random refuses an image URL that is not http(s)", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch(
    [Response.json({ ...CAT, url: "javascript:alert(1)" })],
    async () => {
      await assertRejects(run, Error, "not an http(s) URL: javascript:");
    },
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("random names the endpoint when the body is not JSON", async () => {
  const { run, getWrittenResources } = runRandom();
  await withMockedFetch([new Response("<html>oops</html>")], async () => {
    await assertRejects(
      run,
      Error,
      `cataas GET ${ENDPOINT} returned HTTP 200 with a body that is not JSON`,
    );
  });

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("fetchRandomCat gives up when its timeout passes", async () => {
  const never = new AbortController().signal;
  await withMockedFetch(hangUntilAborted, async () => {
    const error = await assertRejects(
      () => fetchRandomCat(never, 1_000),
      DOMException,
    );
    assertEquals(error.name, "TimeoutError");
  });
});

Deno.test("random stops and writes nothing when aborted", async () => {
  const controller = new AbortController();
  const { run, getWrittenResources } = runRandom(controller.signal);
  await withMockedFetch(hangUntilAborted, async () => {
    const pending = run();
    controller.abort();
    const error = await assertRejects(() => pending, DOMException);
    assertEquals(error.name, "AbortError");
  });

  assertEquals(getWrittenResources().length, 0);
});
