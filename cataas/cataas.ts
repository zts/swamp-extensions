/**
 * Fetches random cats from Cat as a Service (https://cataas.com).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The cataas API this behavior calls. */
export const CATAAS_URL = "https://cataas.com";

/** How long a request to cataas may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;

// Statuses that mean "try again later", not "this request is wrong".
const TRANSIENT_STATUSES = new Set([429, 503]);

// Not strict on purpose: an extra field upstream must not break every run.
const CatResponseSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()),
  created_at: z.string().min(1),
  url: z.string().min(1),
  mimetype: z.string().min(1),
});

const CatSchema = z.object({
  id: z.string().min(1).describe("The cat's cataas id"),
  tags: z.array(z.string()).describe("Tags cataas has for the cat"),
  createdAt: z.string().min(1).describe("When the cat was added to cataas"),
  url: z.url({ protocol: /^https?$/ }).describe(
    "Absolute http(s) URL of the cat's image",
  ),
  mimetype: z.string().min(1).describe("The image's MIME type"),
});

/** A cat as written to the `cat` resource. */
export type Cat = z.infer<typeof CatSchema>;

/**
 * Fetch one random cat from cataas, validated and with an absolute URL.
 * Throws on a non-2xx response, a body that is not JSON or not a cat, a
 * timeout after `timeoutMs`, or an abort of `signal`.
 */
export async function fetchRandomCat(
  signal: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Cat> {
  const endpoint = `${CATAAS_URL}/cat?json=true`;
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    if (TRANSIENT_STATUSES.has(response.status)) {
      const retryAfter = response.headers.get("Retry-After")?.slice(0, 200);
      const wait = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
      throw new Error(
        `cataas GET ${endpoint} returned HTTP ${response.status}, a ` +
          `transient failure; retry later${wait}: ${body}`,
      );
    }
    throw new Error(
      `cataas GET ${endpoint} failed with HTTP ${response.status}: ${body}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cataas GET ${endpoint} returned HTTP ${response.status} with a body ` +
        `that is not JSON: ${detail}`,
    );
  }
  const parsed = CatResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `cataas GET ${endpoint} returned an unexpected body: ${parsed.error.message}`,
    );
  }
  const cat = parsed.data;
  if (!URL.canParse(cat.url, CATAAS_URL)) {
    throw new Error(
      `cataas GET ${endpoint} returned an image URL that cannot be parsed: ` +
        cat.url.slice(0, 200),
    );
  }
  const url = new URL(cat.url, CATAAS_URL);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `cataas GET ${endpoint} returned an image URL that is not an http(s) ` +
        `URL: ${url.protocol}`,
    );
  }
  return {
    id: cat.id,
    tags: cat.tags,
    createdAt: cat.created_at,
    url: url.href,
    mimetype: cat.mimetype,
  };
}

/** Behavior definition for fetching random cats from cataas. */
export const behavior = {
  type: "@zts/cataas",
  version: "2026.10.25.1",
  globalArguments: z.object({}),
  resources: {
    "cat": {
      description: "A random cat from cataas",
      schema: CatSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    random: {
      description: "Fetch a random cat and record it as the 'cat' resource",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          signal: AbortSignal;
          logger: { info(msg: string, props?: Record<string, unknown>): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Fetching a random cat from {url}", {
          url: CATAAS_URL,
        });
        const cat = await fetchRandomCat(context.signal);
        const handle = await context.writeResource("cat", "random", cat);
        context.logger.info("Recorded cat {id}", { id: cat.id });
        return { dataHandles: [handle] };
      },
    },
  },
};
