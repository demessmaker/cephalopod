// Core is the single source of truth for brain + arm; lock its key invariants.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { edgeId, stubId, handle, getTitle, deriveEdges, docKey, b64 } from "../src/index.js";

describe("@cephalopod/core", () => {
  it("edge ids are deterministic and type-sensitive", () => {
    expect(edgeId("a", "b", "rel")).toBe(edgeId("a", "b", "rel"));
    expect(edgeId("a", "b", "rel")).not.toBe(edgeId("a", "b", null));
    expect(stubId("Acme")).toBe(stubId("acme")); // case-insensitive
  });

  it("title is an LWW meta field (not Y.Text)", () => {
    const doc = new Y.Doc();
    const h = handle("n1", doc);
    h.meta.set("title", "Hello");
    h.body.insert(0, "body text");
    expect(getTitle(h)).toBe("Hello");
    expect(h.body.toString()).toBe("body text");
  });

  it("derives + dedups wikilink edges", () => {
    const edges = deriveEdges("n1", "see [[depends_on:: Gw]] and [[Gw]] and [[Gw]]", (t) => "id:" + t);
    expect(edges).toContainEqual({ from: "n1", to: "id:Gw", type: "depends_on", origin: "wikilink" });
    expect(edges.filter((e) => e.type === null)).toHaveLength(1); // duplicate [[Gw]] collapsed
  });

  it("protocol helpers", () => {
    expect(docKey("sp", "n1")).toBe("sp n1");
    const u = new Uint8Array([1, 2, 3]);
    expect([...b64.dec(b64.enc(u))]).toEqual([1, 2, 3]);
  });
});
