// Unit tests for the pure force-directed layout engine.
import { describe, it, expect } from "vitest";
import { buildGraph, layout, bounds, step } from "../src/graph.js";

const sub = {
  nodes: [
    { id: "A", title: "A", stub: false },
    { id: "B", title: "B", stub: false },
    { id: "C", title: "C", stub: true },
  ],
  edges: [
    { from: "A", to: "B", type: "depends_on" },
    { from: "A", to: "ghost", type: "x" }, // endpoint not in nodes -> dropped
  ],
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (n) => Number.isFinite(n.x) && Number.isFinite(n.y);

describe("graph layout", () => {
  it("buildGraph centers the focus and drops dangling links", () => {
    const { nodes, links } = buildGraph("A", sub);
    const a = nodes.find((n) => n.id === "A");
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(nodes.every(finite)).toBe(true);
    expect(links).toHaveLength(1); // the A->ghost edge is filtered out
    expect(links[0]).toMatchObject({ source: "A", target: "B" });
  });

  it("converges: linked nodes settle near the ideal edge length, all finite", () => {
    const { nodes, links } = buildGraph("A", sub);
    layout(nodes, links, 600, { k: 120 });
    expect(nodes.every(finite)).toBe(true);
    const a = nodes.find((n) => n.id === "A");
    const b = nodes.find((n) => n.id === "B");
    const d = dist(a, b);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(260); // around k=120
    // gravity keeps everything bounded
    expect(nodes.every((n) => Math.abs(n.x) < 2000 && Math.abs(n.y) < 2000)).toBe(true);
  });

  it("is deterministic", () => {
    const g1 = buildGraph("A", sub);
    const g2 = buildGraph("A", sub);
    layout(g1.nodes, g1.links, 200);
    layout(g2.nodes, g2.links, 200);
    expect(g1.nodes.map((n) => [n.x, n.y])).toEqual(g2.nodes.map((n) => [n.x, n.y]));
  });

  it("bounds wraps all nodes", () => {
    const { nodes } = buildGraph("A", sub);
    const b = bounds(nodes, 10);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(b.minX);
      expect(n.x).toBeLessThanOrEqual(b.minX + b.w);
    }
  });

  it("step does not produce NaN even when nodes coincide", () => {
    const nodes = [
      { id: "A", x: 0, y: 0, vx: 0, vy: 0, stub: false, title: "A" },
      { id: "B", x: 0, y: 0, vx: 0, vy: 0, stub: false, title: "B" },
    ];
    step(nodes, [], {});
    expect(nodes.every(finite)).toBe(true);
  });
});
