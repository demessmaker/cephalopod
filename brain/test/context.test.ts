// get_context (#28): a token-budgeted context bundle — hybrid search seeds it,
// a 1-hop graph expansion adds linked context, packed in relevance order with
// provenance, and the last note clipped to fit the budget.
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";

const hub = () => new SpaceHub(new SqliteStore(":memory:"));
const S = "kb";

describe("SpaceHub.getContext", () => {
  it("seeds with search hits and pulls in 1-hop linked neighbors", async () => {
    const h = hub();
    await h.createNote(S, { title: "Postgres storage", body: "We persist everything in Postgres with WAL." }, "n_pg");
    await h.createNote(S, { title: "API service", body: "REST endpoints for clients." }, "n_api");
    await h.linkNote(S, "n_api", "n_pg", "depends_on"); // api → pg (so pg's neighborhood includes api)

    const pack = await h.getContext(S, "Postgres", { mode: "text", hops: 1 });
    const byId = new Map(pack.items.map((i) => [i.id, i]));
    expect(byId.get("n_pg")?.relevance).toBe("match"); // direct search hit
    expect(byId.get("n_api")?.relevance).toBe("linked"); // pulled in by expansion
    expect(pack.items[0].id).toBe("n_pg"); // matches rank ahead of neighbors
    expect(pack.edges.some((e) => e.from === "n_api" && e.to === "n_pg")).toBe(true); // local structure kept
    expect(pack.usedTokens).toBeGreaterThan(0);
    expect(pack.truncated).toBe(false); // everything fit
  });

  it("packs in relevance order and clips the first overflowing note to the budget", async () => {
    const h = hub();
    const big = "Postgres ".repeat(2000); // ~18k chars ≫ any small budget
    await h.createNote(S, { title: "Huge note", body: big }, "n_big");

    const pack = await h.getContext(S, "Postgres", { mode: "text", tokenBudget: 50 });
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].truncated).toBe(true);
    expect(pack.items[0].body.length).toBeLessThan(big.length); // clipped
    expect(pack.truncated).toBe(true);
    expect(pack.usedTokens).toBeLessThanOrEqual(50);
  });

  it("stamps provenance (author, draft state, last editor) on each note", async () => {
    const h = hub();
    await h.createNote(S, { title: "Agent draft", body: "Postgres notes from an agent.", tags: ["draft"], props: { authoredBy: "agent" } }, "n_x", "alice");

    const pack = await h.getContext(S, "Postgres", { mode: "text", includeDrafts: true });
    const item = pack.items.find((i) => i.id === "n_x")!;
    expect(item.provenance.draft).toBe(true);
    expect(item.provenance.authoredBy).toBe("agent");
    expect(item.provenance.lastEditedBy).toBe("alice");
    expect(typeof item.provenance.lastEditedAt).toBe("number");
  });

  it("excludes #draft notes unless includeDrafts is set", async () => {
    const h = hub();
    await h.createNote(S, { title: "Hidden draft", body: "Postgres draft.", tags: ["draft"] }, "n_d");

    const without = await h.getContext(S, "Postgres", { mode: "text" });
    expect(without.items.find((i) => i.id === "n_d")).toBeUndefined();

    const withDrafts = await h.getContext(S, "Postgres", { mode: "text", includeDrafts: true });
    expect(withDrafts.items.find((i) => i.id === "n_d")).toBeDefined();
  });

  it("returns an empty pack when nothing matches", async () => {
    const h = hub();
    await h.createNote(S, { title: "Unrelated", body: "Nothing to see." }, "n_u");
    const pack = await h.getContext(S, "Postgres", { mode: "text" });
    expect(pack.items).toHaveLength(0);
    expect(pack.edges).toHaveLength(0);
    expect(pack.truncated).toBe(false);
  });
});
