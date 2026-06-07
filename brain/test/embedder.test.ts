// C3: the real-model embedder seam. `Embedder.embed` is MaybeAsync, so a model
// behind the network (ApiEmbedder) drops in behind the same interface the
// HashingEmbedder uses, and the async hub awaits it on the index + query paths.
import { describe, it, expect } from "vitest";
import { ApiEmbedder, embedderFromEnv, HashingEmbedder, dot } from "../src/embedder.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";

// A stub OpenAI-compatible /embeddings server: deterministic per-text vectors so we
// can assert the hub actually routed through it (and it returns Promises).
function stubEmbedServer(dim = 8) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body));
    calls.push(input);
    const v = new Array(dim).fill(0);
    for (const tok of String(input).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    return new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, dim };
}

describe("ApiEmbedder (async model seam)", () => {
  it("calls an OpenAI-compatible endpoint and returns an L2-normalized vector", async () => {
    const stub = stubEmbedServer(8);
    const emb = new ApiEmbedder({ url: "http://stub/v1/embeddings", model: "m", dim: 8, apiKey: "k", fetchImpl: stub.fetchImpl });
    const v = await emb.embed("billing charges customers");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(8);
    expect(dot(v, v)).toBeCloseTo(1, 5); // normalized: self-dot == 1
    expect(stub.calls).toEqual(["billing charges customers"]);
  });

  it("rejects a dimension mismatch (guards the index from incompatible vectors)", async () => {
    const stub = stubEmbedServer(8);
    const emb = new ApiEmbedder({ url: "http://stub/v1/embeddings", model: "m", dim: 16, fetchImpl: stub.fetchImpl });
    await expect(emb.embed("x")).rejects.toThrow(/dim mismatch/);
  });

  it("surfaces a non-2xx response as an error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const emb = new ApiEmbedder({ url: "http://stub/v1/embeddings", model: "m", dim: 8, fetchImpl });
    await expect(emb.embed("x")).rejects.toThrow(/500/);
  });

  it("embedderFromEnv defaults to hashing, and selects the API embedder when a URL is set", () => {
    expect(embedderFromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(HashingEmbedder);
    const e = embedderFromEnv({ CEPH_EMBED_URL: "http://x/v1/embeddings", CEPH_EMBED_DIM: "8" } as unknown as NodeJS.ProcessEnv);
    expect(e).toBeInstanceOf(ApiEmbedder);
    expect(e.dim).toBe(8);
  });
});

describe("the hub indexes and queries through an async embedder", () => {
  it("semantic search works end-to-end with an ApiEmbedder", async () => {
    const stub = stubEmbedServer(16);
    const embedder = new ApiEmbedder({ url: "http://stub/v1/embeddings", model: "m", dim: 16, fetchImpl: stub.fetchImpl });
    const hub = new SpaceHub(new SqliteStore(":memory:"), { embedder });
    await hub.createNote("kb", { title: "Billing", body: "charges customers monthly" });
    await hub.createNote("kb", { title: "Weather", body: "rain and clouds tomorrow" });

    const hits = await hub.searchSemantic("kb", "charges customers");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe("Billing");
    // the write path (index) AND the query path both went through the async model
    expect(stub.calls).toContain("charges customers");
    expect(stub.calls.some((c) => c.includes("Billing"))).toBe(true);
  });
});
