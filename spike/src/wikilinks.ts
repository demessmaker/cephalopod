// §7 — wikilink parsing & derived-edge reconciliation.
// Pure function over body text -> derived edges. Recomputed wherever the note
// is held; deterministic edge ids collapse duplicates (C3).
import { edgeId } from "./note.js";

export interface EdgeRec {
  from: string;
  to: string;
  type: string | null;
  origin: "wikilink" | "explicit";
}

// Recognizes [[Target]], [[id|alias]], [[type:: Target]], [[code:: url]],
// and trailing #heading / #^block anchors (carried but not resolved in v1).
const WIKILINK = /\[\[\s*(?:([\w-]+)::\s*)?([^\]|#]+?)\s*(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function deriveEdges(
  fromId: string,
  body: string,
  resolve: (titleOrId: string) => string,
): EdgeRec[] {
  const byId = new Map<string, EdgeRec>();
  for (const m of body.matchAll(WIKILINK)) {
    const type = m[1] ?? null;
    const target = resolve(m[2].trim());
    const rec: EdgeRec = { from: fromId, to: target, type, origin: "wikilink" };
    byId.set(edgeId(fromId, target, type), rec); // dedupe by deterministic id
  }
  return [...byId.values()];
}
