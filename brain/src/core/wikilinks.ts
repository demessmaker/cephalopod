// Wikilink parsing & derived-edge reconciliation (graduated from M0, 07 §7).
import { edgeId } from "./ids.js";

export interface EdgeRec {
  from: string;
  to: string;
  type: string | null;
  origin: "wikilink" | "explicit";
}

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
    byId.set(edgeId(fromId, target, type), { from: fromId, to: target, type, origin: "wikilink" });
  }
  return [...byId.values()];
}
