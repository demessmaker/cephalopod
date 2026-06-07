// Backend parity: the same Store contract, verified against both SQLite (async-
// wrapped) and Postgres (PgStore on in-process PGlite). Proves the Postgres scale
// target implements the exact behaviour the brain relies on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SqliteStore } from "../src/store/sqlite.js";
import { PgStore } from "../src/store/pg.js";
import { asyncify, type AsyncStore } from "../src/store/store.js";

const vec = (a: number, b: number, c: number, d: number) => {
  const v = new Float32Array([a, b, c, d]);
  let n = Math.hypot(a, b, c, d) || 1;
  return v.map((x) => x / n);
};
const u = (s: string) => new TextEncoder().encode(s);

interface Backend { name: string; make: () => Promise<{ store: AsyncStore; close: () => Promise<void> }> }

const backends: Backend[] = [
  {
    name: "sqlite",
    make: async () => {
      const s = new SqliteStore(":memory:");
      return { store: asyncify(s), close: async () => s.close() };
    },
  },
  {
    name: "postgres(pglite)",
    make: async () => {
      const pg = await PGlite.create();
      const s = new PgStore(pg);
      await s.init();
      return { store: s, close: async () => s.close() };
    },
  },
];

describe.each(backends)("Store conformance — $name", ({ make }) => {
  let store: AsyncStore;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ store, close } = await make()); });
  afterAll(async () => { await close(); });

  it("spaces", async () => {
    await store.ensureSpace("b");
    await store.ensureSpace("a");
    await store.ensureSpace("a"); // idempotent
    expect(await store.listSpaces()).toEqual(["a", "b"]);
  });

  it("append-only log + ordering + meta", async () => {
    const s1 = await store.appendUpdate("sp", "n1", u("u1"), "alice", 100);
    const s2 = await store.appendUpdate("sp", "n1", u("u2"), "bob", 200);
    expect(s2).toBeGreaterThan(s1);
    const loaded = await store.loadDoc("sp", "n1");
    expect(loaded.updates.map((x) => new TextDecoder().decode(x))).toEqual(["u1", "u2"]);
    const meta = await store.loadDocMeta("sp", "n1");
    expect(meta.updates.map((m) => m.actor)).toEqual(["alice", "bob"]);
    expect(await store.notesTouchedBy("sp", "bob", 150)).toEqual(["n1"]);
    expect(await store.notesTouchedBy("sp", "bob", 250)).toEqual([]);
  });

  it("snapshot compacts the log and reports coversTs", async () => {
    await store.appendUpdate("sp", "n2", u("a"), "x", 10);
    const seq = await store.appendUpdate("sp", "n2", u("b"), "x", 20);
    await store.appendUpdate("sp", "n2", u("c"), "x", 30); // after the snapshot point
    await store.saveSnapshot("sp", "n2", u("SNAP"), seq);
    const loaded = await store.loadDoc("sp", "n2");
    expect(new TextDecoder().decode(loaded.snapshot!.state)).toBe("SNAP");
    expect(loaded.snapshot!.coversTs).toBe(20);
    expect(loaded.updates.map((x) => new TextDecoder().decode(x))).toEqual(["c"]); // a,b compacted away
  });

  it("derived node index + edges + traversal", async () => {
    await store.upsertNode("g", { id: "hub", title: "Hub", tags: ["service"], stub: false });
    await store.upsertNode("g", { id: "leaf", title: "Leaf", tags: ["service", "draft"], stub: false });
    await store.upsertNode("g", { id: "stub1", title: "Ghost", tags: [], stub: true });
    expect((await store.getNode("g", "hub"))?.title).toBe("Hub");
    expect(await store.findIdByTitle("g", "leaf")).toBe("leaf");

    await store.replaceEdgesFrom("g", "hub", [
      { from: "hub", to: "leaf", type: "depends_on", origin: "explicit" },
      { from: "hub", to: "stub1", type: null, origin: "wikilink" },
    ]);
    expect((await store.edgesAdjacent("g", "hub", "out")).length).toBe(2);
    expect((await store.edgesAdjacent("g", "leaf", "in")).map((e) => e.from)).toEqual(["hub"]);
    // replace is authoritative
    await store.replaceEdgesFrom("g", "hub", [{ from: "hub", to: "leaf", type: "calls", origin: "explicit" }]);
    expect((await store.edgesAdjacent("g", "hub", "out")).map((e) => e.type)).toEqual(["calls"]);

    // listNodes: excludes stubs + drafts by default, honors tag filters
    const live = await store.listNodes("g", 50, false, []);
    expect(live.map((n) => n.id).sort()).toEqual(["hub"]); // leaf is draft, stub1 is stub
    expect((await store.listNodes("g", 50, true, [])).map((n) => n.id)).toContain("leaf");
    expect((await store.listNodes("g", 50, true, ["service"])).every((n) => n.tags.includes("service"))).toBe(true);
    expect(await store.tagCounts("g")).toEqual(expect.arrayContaining([{ tag: "service", count: 2 }]));

    await store.deleteNode("g", "stub1");
    expect(await store.getNode("g", "stub1")).toBeUndefined();
  });

  it("full-text search: tokens, draft filter, tag filter, empty query", async () => {
    await store.upsertNode("fts", { id: "a", title: "Billing", tags: ["service"], stub: false });
    await store.upsertNode("fts", { id: "b", title: "Draft One", tags: ["draft"], stub: false });
    await store.searchUpsert("fts", "a", "Billing", "charges customers and processes payments");
    await store.searchUpsert("fts", "b", "Draft One", "charges hidden draft");
    expect(await store.search("fts", "charges", 10, false, [])).toEqual(["a"]); // b is draft
    expect((await store.search("fts", "charges", 10, true, [])).sort()).toEqual(["a", "b"]);
    expect(await store.search("fts", "charges", 10, true, ["service"])).toEqual(["a"]);
    expect(await store.search("fts", "   ", 10, true, [])).toEqual([]);
    await store.searchDelete("fts", "a");
    expect(await store.search("fts", "charges", 10, true, [])).toEqual(["b"]);
  });

  it("semantic search ranks by cosine, excludes drafts", async () => {
    for (const [id, tags] of [["x", []], ["y", []], ["z", ["draft"]]] as const)
      await store.upsertNode("vec", { id, title: id, tags: [...tags], stub: false });
    await store.upsertEmbedding("vec", "x", vec(1, 0, 0, 0));
    await store.upsertEmbedding("vec", "y", vec(0, 1, 0, 0));
    await store.upsertEmbedding("vec", "z", vec(1, 0, 0, 0)); // close to query but draft
    const hits = await store.searchSemantic("vec", vec(0.9, 0.1, 0, 0), 2, false);
    expect(hits[0]).toBe("x");
    expect(hits).not.toContain("z");
    expect(await store.searchSemantic("vec", vec(1, 0, 0, 0), 5, true)).toContain("z");
    await store.deleteEmbedding("vec", "x");
    expect(await store.searchSemantic("vec", vec(1, 0, 0, 0), 5, false)).not.toContain("x");
  });

  it("principals, tokens, capabilities, roles", async () => {
    expect(await store.principalCount()).toBe(0);
    await store.addPrincipal({ id: "u1", kind: "user", name: "Dev" });
    await store.addToken("h1", "u1", JSON.stringify({ mode: "read" }));
    expect((await store.getPrincipal("u1"))?.name).toBe("Dev");
    expect(await store.principalIdByToken("h1")).toBe("u1");
    expect(JSON.parse((await store.getCapabilities("h1"))!).mode).toBe("read");
    expect(await store.principalCount()).toBe(1);

    await store.setRole("sp", "u1", "editor");
    await store.setRole("sp", "u1", "admin"); // upsert
    expect(await store.getRole("sp", "u1")).toBe("admin");
    expect(await store.listMemberships("u1")).toEqual([{ space: "sp", role: "admin" }]);
  });

  it("per-space settings + quota counting", async () => {
    expect(await store.getAgentMode("s")).toBe("draft"); // default
    expect(await store.getSecretScan("s")).toBe("warn"); // default
    expect(await store.getMaxNotes("s")).toBe(0);
    await store.setAgentMode("s", "open");
    await store.setRequiredFacets("s", ["client", "project"]);
    await store.setMaxNotes("s", 5);
    await store.setSecretScan("s", "block");
    expect(await store.getAgentMode("s")).toBe("open");
    expect(await store.getRequiredFacets("s")).toEqual(["client", "project"]);
    expect(await store.getMaxNotes("s")).toBe(5);
    expect(await store.getSecretScan("s")).toBe("block");

    await store.upsertNode("s", { id: "n", title: "N", tags: [], stub: false });
    await store.upsertNode("s", { id: "st", title: "S", tags: [], stub: true });
    expect(await store.countNotes("s")).toBe(1); // stub not counted
  });

  it("hard purge expunges all traces", async () => {
    await store.appendUpdate("p", "doc", u("x"), "a", 1);
    await store.upsertNode("p", { id: "doc", title: "Doc", tags: [], stub: false });
    await store.searchUpsert("p", "doc", "Doc", "secret material");
    await store.upsertEmbedding("p", "doc", vec(1, 0, 0, 0));
    await store.replaceEdgesFrom("p", "doc", [{ from: "doc", to: "other", type: null, origin: "wikilink" }]);

    await store.purgeNote("p", "doc");
    expect(await store.getNode("p", "doc")).toBeUndefined();
    expect(await store.search("p", "secret", 10, true, [])).toEqual([]);
    expect(await store.searchSemantic("p", vec(1, 0, 0, 0), 10, true)).not.toContain("doc");
    expect((await store.loadDoc("p", "doc")).updates).toEqual([]);
    expect(await store.edgesAdjacent("p", "doc", "out")).toEqual([]);
  });

  it("blob store: round-trip, dedupe, isolation, delete", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 13, 10]);
    await store.putBlob("bsp", "b_abc", "image/png", bytes);
    await store.putBlob("bsp", "b_abc", "image/png", bytes); // idempotent (dedupe)
    expect(await store.hasBlob("bsp", "b_abc")).toBe(true);
    const got = await store.getBlob("bsp", "b_abc");
    expect(got?.type).toBe("image/png");
    expect([...(got?.bytes ?? [])]).toEqual([...bytes]); // bytes survive exactly (incl. CRLF/0xFF)
    expect(await store.getBlob("other", "b_abc")).toBeUndefined(); // per-space isolation
    await store.deleteBlob("bsp", "b_abc");
    expect(await store.hasBlob("bsp", "b_abc")).toBe(false);
  });
});
