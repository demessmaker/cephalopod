// An "arm": holds local Y.Doc replicas of its working set, syncs through a Conn,
// caches slices, and exposes edit ops + graph queries.
import * as Y from "yjs";
import { handle, edgeId, getTitle, type NoteHandle, type OutLink } from "./note.js";
import {
  b64,
  type ClientMsg,
  type ServerMsg,
  type Conn,
  type NodeSummary,
  type Scope,
  type GraphQuery,
} from "./protocol.js";
import type { EdgeRec } from "./wikilinks.js";

type ClientConn = Conn<ClientMsg, ServerMsg>;
const REMOTE = "remote"; // Yjs transaction origin for applied remote updates

interface Pending {
  resolve: (v: { nodes: NodeSummary[]; edges: EdgeRec[] }) => void;
}

export class Client {
  private docs = new Map<string, Y.Doc>();
  private pending = new Map<string, Pending>();
  private reqSeq = 0;
  slices: { nodes: NodeSummary[]; edges: EdgeRec[] }[] = [];

  constructor(public name: string, private ch: ClientConn) {
    ch.onMessage((msg) => this.handle(msg));
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "sync2":
      case "update":
        Y.applyUpdate(this.localDoc(msg.note), b64.dec(msg.update), REMOTE);
        break;
      case "sync1": {
        const diff = Y.encodeStateAsUpdate(this.localDoc(msg.note), b64.dec(msg.sv));
        this.ch.send({ t: "sync2", note: msg.note, update: b64.enc(diff) });
        break;
      }
      case "slice":
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve({ nodes: msg.nodes, edges: msg.edges });
        }
        if (msg.t === "slice") this.slices.push({ nodes: msg.nodes, edges: msg.edges });
        break;
      }
    }
  }

  private localDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(id, doc);
      // forward local (non-remote) changes as deltas
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        this.ch.send({ t: "update", note: id, update: b64.enc(update) });
      });
    }
    return doc;
  }

  // Begin syncing a note (creates the local replica if absent).
  open(id: string): NoteHandle {
    const doc = this.localDoc(id);
    this.ch.send({ t: "open", note: id });
    this.ch.send({ t: "sync1", note: id, sv: b64.enc(Y.encodeStateVector(doc)) });
    return handle(id, doc);
  }

  // Re-run the handshake for all open docs (call after a reconnect).
  resync(): void {
    for (const id of this.docs.keys()) {
      this.ch.send({ t: "open", note: id });
      this.ch.send({ t: "sync1", note: id, sv: b64.enc(Y.encodeStateVector(this.docs.get(id)!)) });
    }
  }

  note(id: string): NoteHandle {
    return handle(id, this.localDoc(id));
  }

  // ---- edit ops -----------------------------------------------------------

  setTitle(id: string, title: string): void {
    const meta = this.note(id).meta; // LWW scalar (see note.ts)
    meta.set("title", title);
  }

  title(id: string): string {
    return getTitle(this.note(id));
  }

  appendBody(id: string, text: string): void {
    const b = this.note(id).body;
    b.insert(b.length, text);
  }

  setBody(id: string, text: string): void {
    const b = this.note(id).body;
    b.doc!.transact(() => {
      b.delete(0, b.length);
      b.insert(0, text);
    });
  }

  removeText(id: string, substring: string): void {
    const b = this.note(id).body;
    const idx = b.toString().indexOf(substring);
    if (idx >= 0) b.delete(idx, substring.length);
  }

  link(from: string, to: string, type: string | null = null): void {
    const ol = this.note(from).outLinks;
    ol.set(edgeId(from, to, type), { to, type } as OutLink);
  }

  // ---- graph queries ------------------------------------------------------

  subscribe(scope: Scope): Promise<{ nodes: NodeSummary[]; edges: EdgeRec[] }> {
    const id = `${this.name}:${this.reqSeq++}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ch.send({ t: "subscribe", id, scope });
    });
  }

  query(q: GraphQuery): Promise<{ nodes: NodeSummary[]; edges: EdgeRec[] }> {
    const id = `${this.name}:${this.reqSeq++}`;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ch.send({ t: "query", id, q });
    });
  }

  doc(id: string): Y.Doc {
    return this.localDoc(id);
  }
}
