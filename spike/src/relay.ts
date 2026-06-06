// §8 — trivial relay: authoritative per-note Y.Docs, server-derived adjacency
// (no monolithic index doc, 02 §2.2), scope resolver, and fan-out.
import * as Y from "yjs";
import { handle, edgeId, stubId, getTitle } from "./note.js";
import { deriveEdges, type EdgeRec } from "./wikilinks.js";
import {
  b64,
  type ClientMsg,
  type ServerMsg,
  type Conn,
  type NodeSummary,
  type Scope,
  type GraphQuery,
} from "./protocol.js";

type ServerConn = Conn<ServerMsg, ClientMsg>;

interface ConnState {
  ch: ServerConn;
  open: Set<string>;
}

export class Relay {
  private docs = new Map<string, Y.Doc>();
  private conns = new Set<ConnState>();

  // Server-derived adjacency (02 §2.2).
  private nodes = new Map<string, NodeSummary>();
  private edges = new Map<string, EdgeRec>();
  private edgesFrom = new Map<string, Set<string>>(); // from -> edgeIds
  private backIdx = new Map<string, Set<string>>(); // to   -> edgeIds

  addConnection(ch: ServerConn): void {
    const conn: ConnState = { ch, open: new Set() };
    this.conns.add(conn);
    ch.onMessage((msg) => this.handle(conn, msg));
  }

  private ensureDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(id, doc);
      this.rebuildNote(id);
    }
    return doc;
  }

  private handle(conn: ConnState, msg: ClientMsg): void {
    switch (msg.t) {
      case "subscribe": {
        const { nodes, edges } = this.resolveScope(msg.scope);
        conn.ch.send({ t: "slice", id: msg.id, nodes, edges });
        break;
      }
      case "open": {
        this.ensureDoc(msg.note);
        conn.open.add(msg.note);
        break;
      }
      case "sync1": {
        const doc = this.ensureDoc(msg.note);
        const diff = Y.encodeStateAsUpdate(doc, b64.dec(msg.sv));
        conn.ch.send({ t: "sync2", note: msg.note, update: b64.enc(diff) });
        conn.ch.send({ t: "sync1", note: msg.note, sv: b64.enc(Y.encodeStateVector(doc)) });
        break;
      }
      case "sync2":
      case "update": {
        const doc = this.ensureDoc(msg.note);
        Y.applyUpdate(doc, b64.dec(msg.update), conn); // origin = conn (no echo)
        this.rebuildNote(msg.note);
        // fan out the same bytes to every other connection with this note open
        for (const other of this.conns) {
          if (other === conn || !other.open.has(msg.note)) continue;
          other.ch.send({ t: "update", note: msg.note, update: msg.update });
        }
        break;
      }
      case "query": {
        const { nodes, edges } = this.runQuery(msg.q);
        conn.ch.send({ t: "result", id: msg.id, nodes, edges });
        break;
      }
    }
  }

  // ---- adjacency ----------------------------------------------------------

  private resolveTitle = (titleOrId: string): string => {
    if (titleOrId.startsWith("n_")) return titleOrId;
    const lower = titleOrId.toLowerCase();
    for (const n of this.nodes.values()) {
      if (!n.stub && n.title.toLowerCase() === lower) return n.id;
    }
    const id = stubId(titleOrId);
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, title: titleOrId, tags: [], stub: true });
    }
    return id;
  };

  private rebuildNote(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    const h = handle(id, doc);
    const deleted = !!h.meta.get("deleted");
    if (deleted) {
      this.nodes.delete(id);
    } else {
      this.nodes.set(id, {
        id,
        title: getTitle(h),
        tags: h.tags.toArray(),
        stub: !!h.meta.get("stub"),
      });
    }
    this.removeEdgesFrom(id);
    if (deleted) return;
    for (const v of h.outLinks.values()) {
      this.addEdge({ from: id, to: v.to, type: v.type ?? null, origin: "explicit" });
    }
    for (const e of deriveEdges(id, h.body.toString(), this.resolveTitle)) {
      this.addEdge(e);
    }
  }

  private addEdge(e: EdgeRec): void {
    const eid = edgeId(e.from, e.to, e.type);
    this.edges.set(eid, e);
    (this.edgesFrom.get(e.from) ?? this.setNew(this.edgesFrom, e.from)).add(eid);
    (this.backIdx.get(e.to) ?? this.setNew(this.backIdx, e.to)).add(eid);
  }

  private removeEdgesFrom(id: string): void {
    const set = this.edgesFrom.get(id);
    if (!set) return;
    for (const eid of set) {
      const e = this.edges.get(eid);
      if (e) this.backIdx.get(e.to)?.delete(eid);
      this.edges.delete(eid);
    }
    set.clear();
  }

  private setNew(m: Map<string, Set<string>>, k: string): Set<string> {
    const s = new Set<string>();
    m.set(k, s);
    return s;
  }

  // ---- queries & scope ----------------------------------------------------

  private adjacent(id: string, dir: "out" | "in" | "both"): EdgeRec[] {
    const out: EdgeRec[] = [];
    if (dir === "out" || dir === "both") {
      for (const eid of this.edgesFrom.get(id) ?? []) {
        const e = this.edges.get(eid);
        if (e) out.push(e);
      }
    }
    if (dir === "in" || dir === "both") {
      for (const eid of this.backIdx.get(id) ?? []) {
        const e = this.edges.get(eid);
        if (e) out.push(e);
      }
    }
    return out;
  }

  resolveScope(s: Scope): { nodes: NodeSummary[]; edges: EdgeRec[] } {
    const dir = s.dir ?? "both";
    const seen = new Set(s.focus);
    let frontier = [...s.focus];
    const picked = new Map<string, EdgeRec>();
    for (let h = 0; h < s.hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.adjacent(id, dir)) {
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
    return {
      nodes: [...seen].map((id) => this.nodes.get(id)).filter(Boolean) as NodeSummary[],
      edges: [...picked.values()],
    };
  }

  private runQuery(q: GraphQuery): { nodes: NodeSummary[]; edges: EdgeRec[] } {
    if (q.kind === "backlinks") {
      const edges = this.adjacent(q.note, "in");
      const ids = new Set([q.note, ...edges.map((e) => e.from)]);
      return { nodes: [...ids].map((id) => this.nodes.get(id)).filter(Boolean) as NodeSummary[], edges };
    }
    return this.resolveScope({ focus: [q.note], hops: q.hops ?? 1, dir: q.dir ?? "both" });
  }

  // ---- test/inspection helpers -------------------------------------------

  doc(id: string): Y.Doc | undefined {
    return this.docs.get(id);
  }
  allNodes(): NodeSummary[] {
    return [...this.nodes.values()];
  }
  allEdges(): EdgeRec[] {
    return [...this.edges.values()];
  }
}
