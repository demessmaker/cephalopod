import * as Y from "yjs";

export interface OutLink { to: string; type: string | null }

export interface NoteHandle {
  id: string;
  doc: Y.Doc;
  body: Y.Text;
  tags: Y.Array<string>;
  props: Y.Map<unknown>;
  outLinks: Y.Map<OutLink>;
  meta: Y.Map<unknown>; // title (LWW), createdAt, deleted
}

export function handle(id: string, doc: Y.Doc): NoteHandle {
  return {
    id, doc,
    body: doc.getText("body"),
    tags: doc.getArray<string>("tags"),
    props: doc.getMap("props"),
    outLinks: doc.getMap<OutLink>("outLinks"),
    meta: doc.getMap("meta"),
  };
}
export const getTitle = (h: NoteHandle): string => (h.meta.get("title") as string) ?? "";
