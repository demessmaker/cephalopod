// SpaceHub — the brain's core. Owns authoritative Y.Docs (loaded lazily from the
// store's snapshot+log), persists every delta, snapshots periodically, maintains
// the server-derived graph index, resolves lazy-neighborhood scopes, and fans
// updates out to subscribed connections. Multi-space, with per-space isolation.
import * as Y from "yjs";
import { handle, getTitle } from "./core/note.js";
import { deriveEdges, type EdgeRec } from "./core/wikilinks.js";
import { edgeId, stubId } from "./core/ids.js";
import {
  b64,
  docKey,
  type ClientMsg,
  type ServerMsg,
  type Conn,
  type NodeSummary,
  type Scope,
  type GraphQuery,
} from "./core/protocol.js";
import type { Store } from "./store/store.js";

type ServerConn = Conn<ServerMsg, ClientMsg>;
interface ConnState {
  ch: ServerConn;
  open: Set<string>; // docKey()s this connection has open
}

interface DocState {
  doc: Y.Doc;
  lastSeq: number; // seq of the most recent persisted update
  sinceSnap: number; // updates since last snapshot
}

export interface HubOptions {
  snapshotEvery?: number; // take a snapshot after N updates to a doc
}

export class SpaceHub {
  private docs = new Map<string, DocState>();
  private conns = new Set<ConnState>();
  private snapshotEvery: number;

  constructor(private store: Store, opts: HubOptions = {}) {
    this.snapshotEvery = opts.snapshotEvery ?? 50;
  }

  addConnection(ch: ServerConn): ConnState {
    const conn: ConnState = { ch, open: new Set() };
    this.conns.add(conn);
    ch.onMessage((msg) => this.handle(conn, msg));
    return conn;
  }
  removeConnection(conn: ConnState): void {
    this.conns.delete(conn);
  }

  // Load a doc into memory from snapshot + log tail (rehydration), or create it.
  private getDoc(space: string, note: string): DocState {
    const key = docKey(space, note);
    let st = this.docs.get(key);
    if (st) return st;
    const doc = new Y.Doc();
    const { snapshot, updates } = this.store.loadDoc(space, note);
    if (snapshot) Y.applyUpdate(doc, snapshot.state, "load");
    for (const u of updates) Y.applyUpdate(doc, u, "load");
    st = { doc, lastSeq: 0, sinceSnap: 0 };
    this.docs.set(key, st);
    this.reindex(space, note, doc); // ensure derived index reflects loaded state
    return st;
  }

  private handle(conn: ConnState, msg: ClientMsg): void {
    switch (msg.t) {
      case "subscribe": {
        const r = this.resolveScope(msg.space, msg.scope);
        conn.ch.send({ t: "slice", id: msg.id, ...r });
        break;
      }
      case "open": {
        this.store.ensureSpace(msg.space);
        this.getDoc(msg.space, msg.note);
        conn.open.add(docKey(msg.space, msg.note));
        break;
      }
      case "sync1": {
        const { doc } = this.getDoc(msg.space, msg.note);
        const diff = Y.encodeStateAsUpdate(doc, b64.dec(msg.sv));
        conn.ch.send({ t: "sync2", space: msg.space, note: msg.note, update: b64.enc(diff) });
        conn.ch.send({ t: "sync1", space: msg.space, note: msg.note, sv: b64.enc(Y.encodeStateVector(doc)) });
        break;
      }
      case "sync2":
      case "update": {
        this.applyClientDelta(conn, msg.space, msg.note, b64.dec(msg.update), msg.update);
        break;
      }
      case "query": {
        const r = this.runQuery(msg.space, msg.q);
        conn.ch.send({ t: "result", id: msg.id, ...r });
        break;
      }
    }
  }

  private applyClientDelta(conn: ConnState, space: string, note: string, bytes: Uint8Array, raw: string): void {
    const st = this.getDoc(space, note);
    Y.applyUpdate(st.doc, bytes, conn); // origin = conn
    // 1) durably log the delta (append-only, 04 §2.3)
    st.lastSeq = this.store.appendUpdate(space, note, bytes);
    // 2) refresh the derived index for this note
    this.reindex(space, note, st.doc);
    // 3) snapshot policy
    if (++st.sinceSnap >= this.snapshotEvery) {
      this.snapshot(space, note, st);
    }
    // 4) fan out the same bytes to other connections with this doc open
    const key = docKey(space, note);
    for (const other of this.conns) {
      if (other === conn || !other.open.has(key)) continue;
      other.ch.send({ t: "update", space, note, update: raw });
    }
  }

  private snapshot(space: string, note: string, st: DocState): void {
    this.store.saveSnapshot(space, note, Y.encodeStateAsUpdate(st.doc), st.lastSeq);
    st.sinceSnap = 0;
  }

  // Flush snapshots for all loaded docs (call on graceful shutdown).
  snapshotAll(): void {
    for (const [key, st] of this.docs) {
      const [space, note] = key.split(" ");
      if (st.lastSeq > 0) this.snapshot(space, note, st);
    }
  }

  // ---- derived graph index (02 §2.2) -------------------------------------

  private resolveTitle(space: string): (titleOrId: string) => string {
    return (titleOrId: string) => {
      if (titleOrId.startsWith("n_")) return titleOrId;
      const found = this.store.findIdByTitle(space, titleOrId.toLowerCase());
      if (found) return found;
      const id = stubId(titleOrId);
      if (!this.store.getNode(space, id)) {
        this.store.upsertNode(space, { id, title: titleOrId, tags: [], stub: true });
      }
      return id;
    };
  }

  private reindex(space: string, note: string, doc: Y.Doc): void {
    const h = handle(note, doc);
    if (h.meta.get("deleted")) {
      this.store.deleteNode(space, note);
      this.store.replaceEdgesFrom(space, note, []);
      return;
    }
    this.store.upsertNode(space, {
      id: note,
      title: getTitle(h),
      tags: h.tags.toArray(),
      stub: !!h.meta.get("stub"),
    });
    const explicit: EdgeRec[] = [...h.outLinks.values()].map((v) => ({
      from: note,
      to: v.to,
      type: v.type ?? null,
      origin: "explicit" as const,
    }));
    const derived = deriveEdges(note, h.body.toString(), this.resolveTitle(space));
    this.store.replaceEdgesFrom(space, note, [...explicit, ...derived]);
  }

  // ---- scope & queries ---------------------------------------------------

  resolveScope(space: string, s: Scope): { nodes: NodeSummary[]; edges: EdgeRec[] } {
    const dir = s.dir ?? "both";
    const seen = new Set(s.focus);
    let frontier = [...s.focus];
    const picked = new Map<string, EdgeRec>();
    for (let h = 0; h < s.hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.store.edgesAdjacent(space, id, dir)) {
          picked.set(edgeId(e.from, e.to, e.type), e);
          const other = e.from === id ? e.to : e.from;
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen].map((id) => this.store.getNode(space, id)).filter(Boolean) as NodeSummary[];
    return { nodes, edges: [...picked.values()] };
  }

  private runQuery(space: string, q: GraphQuery): { nodes: NodeSummary[]; edges: EdgeRec[] } {
    if (q.kind === "backlinks") {
      const edges = this.store.edgesAdjacent(space, q.note, "in");
      const ids = new Set([q.note, ...edges.map((e) => e.from)]);
      const nodes = [...ids].map((id) => this.store.getNode(space, id)).filter(Boolean) as NodeSummary[];
      return { nodes, edges };
    }
    return this.resolveScope(space, { focus: [q.note], hops: q.hops ?? 1, dir: q.dir ?? "both" });
  }

  // ---- test/inspection ---------------------------------------------------
  docState(space: string, note: string): Y.Doc {
    return this.getDoc(space, note).doc;
  }
}
