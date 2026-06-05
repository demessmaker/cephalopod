import * as Y from "yjs";
import { handle } from "../src/core/note.js";
import { edgeId } from "../src/core/ids.js";
import { b64, type ClientMsg, type ServerMsg, type Conn, type Scope, type GraphQuery } from "../src/core/protocol.js";
import type { EdgeRec } from "../src/core/wikilinks.js";

export interface NoteFields {
  title?: string;
  body?: string;
  tags?: string[];
  links?: { to: string; type?: string | null }[];
}

// One-shot full-state update for a fresh note.
export function makeNote(id: string, f: NoteFields): Uint8Array {
  const doc = new Y.Doc();
  const h = handle(id, doc);
  doc.transact(() => {
    if (f.title !== undefined) h.meta.set("title", f.title);
    if (f.body !== undefined) h.body.insert(0, f.body);
    if (f.tags) for (const t of f.tags) h.tags.push([t]);
    if (f.links) for (const l of f.links) h.outLinks.set(edgeId(id, l.to, l.type ?? null), { to: l.to, type: l.type ?? null });
  });
  return Y.encodeStateAsUpdate(doc);
}

// A live note that records incremental updates (for snapshot/compaction tests).
export function liveNote(id: string) {
  const doc = new Y.Doc();
  const h = handle(id, doc);
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  return { doc, h, updates };
}

type Result = { nodes: any[]; edges: EdgeRec[] };

// Drives a SpaceHub as if it were a client. Hub processes synchronously, so
// query/subscribe promises resolve during send().
export class TestClient {
  conn: Conn<ServerMsg, ClientMsg>;
  private hubHandler?: (m: ClientMsg) => void;
  private pending = new Map<string, (r: Result) => void>();
  private seq = 0;
  received: ServerMsg[] = [];

  constructor() {
    this.conn = {
      send: (m: ServerMsg) => {
        this.received.push(m);
        if (m.t === "result" || m.t === "slice") {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p({ nodes: m.nodes, edges: m.edges });
          }
        }
      },
      onMessage: (cb) => {
        this.hubHandler = cb;
      },
    };
  }

  send(m: ClientMsg): void {
    this.hubHandler!(m);
  }

  applyNote(space: string, note: string, update: Uint8Array): void {
    this.send({ t: "open", space, note });
    this.send({ t: "update", space, note, update: b64.enc(update) });
  }

  open(space: string, note: string): void {
    this.send({ t: "open", space, note });
  }

  query(space: string, q: GraphQuery): Promise<Result> {
    const id = "q" + this.seq++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ t: "query", id, space, q });
    });
  }

  subscribe(space: string, scope: Scope): Promise<Result> {
    const id = "s" + this.seq++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ t: "subscribe", id, space, scope });
    });
  }
}
