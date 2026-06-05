// Note document schema (graduated from M0; title is an LWW meta field, NOT
// Y.Text — see the M0 finding in 07 §9 / 02 §2.1).
import * as Y from "yjs";

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
  meta: Y.Map<unknown>; // title (LWW), createdAt/By, stub, deleted
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
