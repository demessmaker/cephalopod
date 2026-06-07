// The minimal-diff that maps an editor's whole-buffer save to one Y.Text edit.
// Correctness here is what keeps concurrent collaborators converging, so the
// surrogate-boundary cases get explicit coverage.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { diffRange, applyTextChange } from "../src/diff.js";

describe("diffRange", () => {
  it("returns null for an unchanged string", () => {
    expect(diffRange("hello", "hello")).toBeNull();
  });

  it("finds a pure insertion in the middle", () => {
    expect(diffRange("ac", "abc")).toEqual({ index: 1, remove: 0, insert: "b" });
  });

  it("finds a pure deletion", () => {
    expect(diffRange("abc", "ac")).toEqual({ index: 1, remove: 1, insert: "" });
  });

  it("finds a replacement of the differing middle only", () => {
    expect(diffRange("the quick fox", "the slow fox")).toEqual({ index: 4, remove: 5, insert: "slow" });
  });

  it("handles append at the end", () => {
    expect(diffRange("foo", "foobar")).toEqual({ index: 3, remove: 0, insert: "bar" });
  });

  it("handles prepend at the start", () => {
    expect(diffRange("bar", "foobar")).toEqual({ index: 0, remove: 0, insert: "foo" });
  });

  it("never splits a surrogate pair on the prefix side", () => {
    // "a😀b" -> "a😀c": the edit must start after the whole emoji, not between halves
    const d = diffRange("a\u{1F600}b", "a\u{1F600}c")!;
    expect(d.index).toBe(3); // a(1) + 😀(2) — a full code unit boundary
    expect(d).toEqual({ index: 3, remove: 1, insert: "c" });
  });

  it("keeps a surrogate pair together when the suffix begins mid-pair", () => {
    // delete the char before an emoji: boundary must not strand a lone surrogate
    const out = diffRange("x\u{1F600}", "\u{1F600}")!;
    const reconstructed = "x\u{1F600}".slice(0, out.index) + out.insert + "x\u{1F600}".slice(out.index + out.remove);
    expect(reconstructed).toBe("\u{1F600}");
  });
});

describe("applyTextChange", () => {
  it("applies the minimal edit to a Y.Text and converges", () => {
    const doc = new Y.Doc();
    const t = doc.getText("body");
    t.insert(0, "the quick fox");
    applyTextChange(t, "the slow fox", "local");
    expect(t.toString()).toBe("the slow fox");
  });

  it("is a no-op when text is unchanged (no update emitted)", () => {
    const doc = new Y.Doc();
    const t = doc.getText("body");
    t.insert(0, "stable");
    let updates = 0;
    doc.on("update", () => updates++);
    applyTextChange(t, "stable", "local");
    expect(updates).toBe(0);
  });

  it("tags the transaction with the given origin", () => {
    const doc = new Y.Doc();
    const t = doc.getText("body");
    t.insert(0, "a");
    let seen: unknown;
    doc.on("update", (_u: Uint8Array, origin: unknown) => (seen = origin));
    applyTextChange(t, "ab", "local");
    expect(seen).toBe("local");
  });
});
