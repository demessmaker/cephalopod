// Pure, framework-free force-directed layout for the graph explorer.
// Deterministic (no randomness) so it is unit-testable. Fruchterman–Reingold-ish:
// link attraction + all-pairs repulsion + gentle gravity toward the origin.

/** @typedef {{id:string,title:string,stub:boolean,x:number,y:number,vx:number,vy:number}} LNode */
/** @typedef {{source:string,target:string,type:string|null}} LLink */

/**
 * Build positioned nodes/links from a brain subgraph ({nodes, edges}).
 * Focus node is centered; others start on a deterministic circle.
 * @returns {{nodes: LNode[], links: LLink[]}}
 */
export function buildGraph(focusId, subgraph, radius = 200) {
  const nodes = subgraph.nodes.map((n, i, arr) => {
    if (n.id === focusId) return { ...n, x: 0, y: 0, vx: 0, vy: 0 };
    const angle = (i / Math.max(1, arr.length)) * Math.PI * 2;
    return { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const links = subgraph.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ source: e.from, target: e.to, type: e.type ?? null }));
  return { nodes, links };
}

/**
 * Advance the simulation by one tick (mutates node positions). Deterministic.
 * @param {LNode[]} nodes @param {LLink[]} links
 */
export function step(nodes, links, opts = {}) {
  const k = opts.k ?? 120; // ideal edge length
  const gravity = opts.gravity ?? 0.02;
  const damping = opts.damping ?? 0.85;
  const repulsion = opts.repulsion ?? 1; // scale
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // repulsion (all pairs)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const d = Math.sqrt(d2);
      const f = (repulsion * (k * k)) / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }
  // attraction along links (Hooke spring toward ideal length k)
  for (const l of links) {
    const a = byId.get(typeof l.source === "string" ? l.source : l.source.id);
    const b = byId.get(typeof l.target === "string" ? l.target : l.target.id);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const spring = ((d - k) / k) * k * 0.1; // pull together if d>k, push apart if d<k
    const ux = dx / d, uy = dy / d;
    a.vx += ux * spring; a.vy += uy * spring;
    b.vx -= ux * spring; b.vy -= uy * spring;
  }
  // gravity + integrate
  for (const n of nodes) {
    n.vx += -n.x * gravity;
    n.vy += -n.y * gravity;
    n.vx *= damping;
    n.vy *= damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

/** Run `iters` ticks. Returns the same nodes array (mutated). */
export function layout(nodes, links, iters = 300, opts = {}) {
  for (let i = 0; i < iters; i++) step(nodes, links, opts);
  return nodes;
}

/** Bounding box of node positions (for viewBox fitting). */
export function bounds(nodes, pad = 60) {
  if (!nodes.length) return { minX: -100, minY: -100, w: 200, h: 200 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  return { minX: minX - pad, minY: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}
