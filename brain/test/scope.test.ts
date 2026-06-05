// M1: server-derived graph index — traversal and backlinks over persisted edges.
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { stubId } from "../src/core/ids.js";
import { TestClient, makeNote } from "./helpers.js";

function build() {
  const store = new SqliteStore(":memory:");
  const hub = new SpaceHub(store);
  const c = new TestClient();
  hub.addConnection(c.conn);
  // hub note links explicitly to n1..n3 and wikilinks to a stub
  c.applyNote("sp", "hub", makeNote("hub", {
    title: "Hub",
    body: "ref [[Faraway]]",
    links: [{ to: "n1" }, { to: "n2", type: "depends_on" }, { to: "n3" }],
  }));
  for (const id of ["n1", "n2", "n3"]) c.applyNote("sp", id, makeNote(id, { title: id.toUpperCase() }));
  return { store, hub, c };
}

describe("M1 brain — derived graph index", () => {
  it("neighbors(hops:1) returns the focus + adjacent nodes only", async () => {
    const { c } = build();
    const r = await c.query("sp", { note: "hub", kind: "neighbors", hops: 1 });
    const ids = r.nodes.map((n) => n.id).sort();
    expect(ids).toContain("hub");
    expect(ids).toContain("n1");
    expect(ids).toContain("n2");
    expect(ids).toContain("n3");
    expect(ids).toContain(stubId("Faraway"));
    expect(r.edges.some((e) => e.to === "n2" && e.type === "depends_on" && e.origin === "explicit")).toBe(true);
    expect(r.edges.some((e) => e.to === stubId("Faraway") && e.origin === "wikilink")).toBe(true);
  });

  it("backlinks resolve via the reverse index", async () => {
    const { c } = build();
    const back = await c.query("sp", { note: "n1", kind: "backlinks" });
    expect(back.edges.map((e) => e.from)).toContain("hub");
  });

  it("subscribe streams a bounded slice", async () => {
    const { c } = build();
    const slice = await c.subscribe("sp", { focus: ["hub"], hops: 1 });
    expect(slice.nodes.length).toBe(5); // hub + n1,n2,n3 + Faraway stub
  });
});
