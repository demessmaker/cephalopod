// §5 — the note document (spike schema) + id helpers.
// A note is a Y.Doc. body is a Y.Text of raw markdown (spike simplification,
// see 07 §2). Explicit edges live in `outLinks` (OR-Set keyed by edge id).
import * as Y from "yjs";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export interface OutLink {
  to: string;
  type: string | null;
  props?: Record<string, unknown>;
}

export interface NoteHandle {
  id: string;
  doc: Y.Doc;
  body: Y.Text;
  tags: Y.Array<string>;
  props: Y.Map<unknown>;
  outLinks: Y.Map<OutLink>;
  // meta is a Y.Map -> LWW per key. `title` lives here (a scalar, so LWW; see
  // the M0 finding in 07 §9: Y.Text would character-merge, not last-writer-win).
  meta: Y.Map<unknown>;
}

export function handle(id: string, doc: Y.Doc): NoteHandle {
  return {
    id,
    doc,
    body: doc.getText("body"),
    tags: doc.getArray<string>("tags"),
    props: doc.getMap("props"),
    outLinks: doc.getMap<OutLink>("outLinks"),
    meta: doc.getMap("meta"),
  };
}

export function getTitle(h: NoteHandle): string {
  return (h.meta.get("title") as string) ?? "";
}

// Deterministic edge id (01 §2.3): same logical edge -> same id on every replica.
export function edgeId(from: string, to: string, type: string | null): string {
  const h = bytesToHex(blake3(utf8ToBytes(`${from}→${to}::${type ?? ""}`)));
  return "e_" + h.slice(0, 24);
}

// Note id: ULID-ish, monotonic-enough for the spike.
export function newNoteId(): string {
  return (
    "n_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

// Deterministic stub id from a title, so independent replicas derive the same
// stub target for an unresolved [[wikilink]] (01 §2.2).
export function stubId(title: string): string {
  const h = bytesToHex(blake3(utf8ToBytes("stub:" + title.toLowerCase())));
  return "n_stub_" + h.slice(0, 16);
}
