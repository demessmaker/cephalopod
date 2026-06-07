// #18 — the explorer's CRDT engine is vendored same-origin (no third-party CDN /
// SRI gap). These guard that the committed bundles are present, functional, and
// structured so the import map yields a single Yjs instance.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const vurl = (f) => new URL(`../src/vendor/${f}`, import.meta.url);
const read = (u) => readFileSync(u, "utf8");
const bareImports = (src) =>
  [...new Set([...src.matchAll(/(?:import|from)\s*"([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith(".") && !s.startsWith("/")))];

describe("vendored browser bundles (same-origin)", () => {
  it("yjs bundle is self-contained and functional", async () => {
    const Y = await import(vurl("yjs.js").href);
    const doc = new Y.Doc();
    const t = doc.getText("body");
    t.insert(0, "hi 😀");
    expect(t.toString()).toBe("hi 😀");
    expect(typeof Y.encodeStateAsUpdate).toBe("function");
    expect(typeof Y.applyUpdate).toBe("function");
  });

  it("yjs bundle has no third-party CDN reference", () => {
    expect(read(vurl("yjs.js"))).not.toContain("esm.sh");
    expect(bareImports(read(vurl("yjs.js")))).toEqual([]); // fully self-contained
  });

  it("awareness shares the ONE Yjs via an external import (no duplicate copy)", () => {
    const src = read(vurl("y-protocols-awareness.js"));
    expect(bareImports(src)).toEqual(["yjs"]); // only `yjs` is external -> import-map shared
    expect(src).not.toContain("esm.sh");
  });

  it("index.html import map is same-origin, not a CDN", () => {
    const html = read(new URL("../src/index.html", import.meta.url));
    expect(html).not.toContain("esm.sh");
    expect(html).toMatch(/"yjs":\s*"\/vendor\/yjs\.js"/);
    expect(html).toMatch(/"y-protocols\/awareness":\s*"\/vendor\/y-protocols-awareness\.js"/);
  });
});
