// M5 acceptance: semantic (vector) + hybrid search.
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { HashingEmbedder, dot } from "../src/embedder.js";

describe("M5 — embeddings", () => {
  it("are deterministic, normalized, and capture token overlap", () => {
    const e = new HashingEmbedder();
    const a = e.embed("billing charges customers");
    const a2 = e.embed("billing charges customers");
    expect([...a]).toEqual([...a2]); // deterministic
    expect(dot(a, a2)).toBeCloseTo(1, 5); // normalized self-similarity == 1
    const related = e.embed("billing and charges");
    const unrelated = e.embed("kafka streaming partitions");
    expect(dot(a, related)).toBeGreaterThan(dot(a, unrelated));
  });
});

function seed() {
  const store = new SqliteStore(":memory:");
  const hub = new SpaceHub(store);
  hub.createNote("sp", { title: "Billing Service", body: "charges customers and processes payments" }, "n_a");
  hub.createNote("sp", { title: "Payments Gateway", body: "payment processing and charges" }, "n_b");
  hub.createNote("sp", { title: "Kafka Tuning", body: "streaming throughput and partitions" }, "n_c");
  hub.createNote("sp", { title: "Payment Audit", body: "ledger of payment charges", tags: ["draft"] }, "n_d");
  return { store, hub };
}

describe("M5 — semantic & hybrid search", () => {
  it("semantic search ranks token-related notes above unrelated ones", () => {
    const { hub } = seed();
    const hits = hub.searchSemantic("sp", "payment charges", 2).map((n) => n.id);
    expect(hits).toContain("n_a");
    expect(hits).toContain("n_b");
    expect(hits).not.toContain("n_c"); // unrelated falls outside top-2
  });

  it("hybrid fuses lexical + semantic results", () => {
    const { hub } = seed();
    const ids = hub.searchHybrid("sp", "payments", 3).map((n) => n.id);
    expect(ids).toContain("n_a");
    expect(ids).toContain("n_b");
  });

  it("drafts are excluded from semantic search unless requested", () => {
    const { hub } = seed();
    expect(hub.searchSemantic("sp", "payment charges ledger", 10).map((n) => n.id)).not.toContain("n_d");
    expect(hub.searchSemantic("sp", "payment charges ledger", 10, true).map((n) => n.id)).toContain("n_d");
  });

  it("searchMode dispatches text/semantic/hybrid", () => {
    const { hub } = seed();
    expect(hub.searchMode("sp", "kafka", "text", 5).map((n) => n.id)).toContain("n_c");
    expect(hub.searchMode("sp", "streaming partitions", "semantic", 1).map((n) => n.id)).toContain("n_c");
  });
});
