// SpaceHub — the brain's core. Owns authoritative Y.Docs (loaded lazily from the
// store's snapshot+log), persists every delta, snapshots periodically, maintains
// the server-derived graph index, resolves lazy-neighborhood scopes, and fans
// updates out to subscribed connections. Multi-space, with per-space isolation.
import * as Y from "yjs";
import { handle, getTitle, type NoteHandle } from "./core/note.js";
import { deriveEdges, type EdgeRec } from "./core/wikilinks.js";
import { edgeId, stubId, newNoteId } from "./core/ids.js";
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
import { HashingEmbedder, type Embedder } from "./embedder.js";

type ServerConn = Conn<ServerMsg, ClientMsg>;

// A connection's access policy (built from token -> principal -> role by the
// ws-server; tests/internal callers use ALLOW_ALL).
export interface ConnAuth {
  canRead(space: string): boolean;
  canWrite(space: string): boolean;
}
export const ALLOW_ALL: ConnAuth = { canRead: () => true, canWrite: () => true };

interface ConnState {
  ch: ServerConn;
  open: Set<string>; // docKey()s this connection has open
  auth: ConnAuth;
}

export interface NoteFields {
  title?: string;
  body?: string;
  tags?: string[];
  props?: Record<string, unknown>;
}
export interface NoteSnapshot {
  id: string;
  title: string;
  body: string;
  tags: string[];
  props: Record<string, unknown>;
  outLinks: { to: string; type: string | null }[];
  deleted: boolean;
}

interface DocState {
  doc: Y.Doc;
  lastSeq: number; // seq of the most recent persisted update
  sinceSnap: number; // updates since last snapshot
}

export interface HubOptions {
  snapshotEvery?: number; // take a snapshot after N updates to a doc
  embedder?: Embedder; // pluggable embeddings (default: HashingEmbedder)
}

export type SearchMode = "text" | "semantic" | "hybrid";

export class SpaceHub {
  private docs = new Map<string, DocState>();
  private conns = new Set<ConnState>();
  private snapshotEvery: number;
  private embedder: Embedder;

  constructor(private store: Store, opts: HubOptions = {}) {
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.embedder = opts.embedder ?? new HashingEmbedder();
  }

  addConnection(ch: ServerConn, auth: ConnAuth = ALLOW_ALL): ConnState {
    const conn: ConnState = { ch, open: new Set(), auth };
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

  private deny(conn: ConnState, action: string, space: string): void {
    conn.ch.send({ t: "error", code: "scope_denied", message: `not allowed to ${action} ${space}` });
  }

  private handle(conn: ConnState, msg: ClientMsg): void {
    // ACL: every read requires canRead(space); every write requires canWrite.
    switch (msg.t) {
      case "subscribe": {
        if (!conn.auth.canRead(msg.space)) return this.deny(conn, "read", msg.space);
        const r = this.resolveScope(msg.space, msg.scope);
        conn.ch.send({ t: "slice", id: msg.id, ...r });
        break;
      }
      case "open": {
        if (!conn.auth.canRead(msg.space)) return this.deny(conn, "read", msg.space);
        this.store.ensureSpace(msg.space);
        this.getDoc(msg.space, msg.note);
        conn.open.add(docKey(msg.space, msg.note));
        break;
      }
      case "sync1": {
        if (!conn.auth.canRead(msg.space)) return this.deny(conn, "read", msg.space);
        const { doc } = this.getDoc(msg.space, msg.note);
        const diff = Y.encodeStateAsUpdate(doc, b64.dec(msg.sv));
        conn.ch.send({ t: "sync2", space: msg.space, note: msg.note, update: b64.enc(diff) });
        conn.ch.send({ t: "sync1", space: msg.space, note: msg.note, sv: b64.enc(Y.encodeStateVector(doc)) });
        break;
      }
      case "sync2":
      case "update": {
        if (!conn.auth.canWrite(msg.space)) return this.deny(conn, "write", msg.space);
        this.applyClientDelta(conn, msg.space, msg.note, b64.dec(msg.update), msg.update);
        break;
      }
      case "query": {
        if (!conn.auth.canRead(msg.space)) return this.deny(conn, "read", msg.space);
        const r = this.runQuery(msg.space, msg.q);
        conn.ch.send({ t: "result", id: msg.id, ...r });
        break;
      }
    }
  }

  private applyClientDelta(conn: ConnState, space: string, note: string, bytes: Uint8Array, raw: string): void {
    const st = this.getDoc(space, note);
    Y.applyUpdate(st.doc, bytes, conn); // origin = conn
    this.commit(space, note, st, bytes, raw, conn);
  }

  // Shared persist + index + snapshot + fan-out path for both WS deltas and
  // server-side (HTTP/MCP) edits.
  private commit(space: string, note: string, st: DocState, bytes: Uint8Array, raw: string, except?: ConnState): void {
    st.lastSeq = this.store.appendUpdate(space, note, bytes); // append-only log (04 §2.3)
    this.reindex(space, note, st.doc); // refresh derived index + FTS
    if (++st.sinceSnap >= this.snapshotEvery) this.snapshot(space, note, st);
    const key = docKey(space, note);
    for (const other of this.conns) {
      if (other === except || !other.open.has(key)) continue;
      other.ch.send({ t: "update", space, note, update: raw });
    }
  }

  // Apply a server-side edit (HTTP/MCP) through the same write path as WS deltas,
  // so all writers converge (02 §2.1). Captures the resulting CRDT update.
  private applyLocalEdit(space: string, note: string, fn: (h: NoteHandle) => void): void {
    const st = this.getDoc(space, note);
    let captured: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin === "http") captured = u;
    };
    st.doc.on("update", onUpdate);
    st.doc.transact(() => fn(handle(note, st.doc)), "http");
    st.doc.off("update", onUpdate);
    if (captured) this.commit(space, note, st, captured, b64.enc(captured));
  }

  // ---- HTTP/MCP command surface (03 §2) ----------------------------------

  createNote(space: string, fields: NoteFields, id = newNoteId()): string {
    this.store.ensureSpace(space);
    this.applyLocalEdit(space, id, (h) => {
      h.meta.set("createdAt", new Date().toISOString());
      if (fields.title !== undefined) h.meta.set("title", fields.title);
      if (fields.body) h.body.insert(0, fields.body);
      if (fields.tags) for (const t of fields.tags) h.tags.push([t]);
      if (fields.props) for (const [k, v] of Object.entries(fields.props)) h.props.set(k, v);
    });
    return id;
  }

  patchNote(space: string, note: string, patch: NoteFields): void {
    this.applyLocalEdit(space, note, (h) => {
      if (patch.title !== undefined) h.meta.set("title", patch.title);
      if (patch.body !== undefined) {
        h.body.delete(0, h.body.length);
        h.body.insert(0, patch.body);
      }
      if (patch.tags !== undefined) {
        h.tags.delete(0, h.tags.length);
        for (const t of patch.tags) h.tags.push([t]);
      }
      if (patch.props) for (const [k, v] of Object.entries(patch.props)) h.props.set(k, v);
    });
  }

  deleteNote(space: string, note: string): void {
    this.applyLocalEdit(space, note, (h) => h.meta.set("deleted", true));
  }

  linkNote(space: string, from: string, to: string, type: string | null = null): void {
    this.applyLocalEdit(space, from, (h) => h.outLinks.set(edgeId(from, to, type), { to, type }));
  }
  unlinkNote(space: string, from: string, to: string, type: string | null = null): void {
    this.applyLocalEdit(space, from, (h) => h.outLinks.delete(edgeId(from, to, type)));
  }

  getNoteSnapshot(space: string, note: string): NoteSnapshot {
    const h = handle(note, this.getDoc(space, note).doc);
    return {
      id: note,
      title: getTitle(h),
      body: h.body.toString(),
      tags: h.tags.toArray(),
      props: Object.fromEntries(h.props.entries()),
      outLinks: [...h.outLinks.values()].map((v) => ({ to: v.to, type: v.type ?? null })),
      deleted: !!h.meta.get("deleted"),
    };
  }

  search(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): NodeSummary[] {
    return this.nodesFor(space, this.store.search(space, query, limit, includeDrafts, tagFilters));
  }
  searchSemantic(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): NodeSummary[] {
    return this.nodesFor(space, this.semanticIds(space, query, limit, includeDrafts, tagFilters));
  }
  // Reciprocal-rank fusion of lexical (FTS) + semantic (vector) results (03 §3).
  searchHybrid(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): NodeSummary[] {
    const lex = this.store.search(space, query, limit * 2, includeDrafts, tagFilters);
    const sem = this.semanticIds(space, query, limit * 2, includeDrafts, tagFilters);
    const K = 60;
    const score = new Map<string, number>();
    const fuse = (ids: string[]) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (K + i)));
    fuse(lex);
    fuse(sem);
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
    return this.nodesFor(space, ranked);
  }
  searchMode(space: string, query: string, mode: SearchMode, limit = 20, includeDrafts = false, tagFilters: string[] = []): NodeSummary[] {
    if (mode === "semantic") return this.searchSemantic(space, query, limit, includeDrafts, tagFilters);
    if (mode === "hybrid") return this.searchHybrid(space, query, limit, includeDrafts, tagFilters);
    return this.search(space, query, limit, includeDrafts, tagFilters);
  }
  // vector ids, post-filtered by facet tags (the store's vector scan has no tag clause)
  private semanticIds(space: string, query: string, limit: number, includeDrafts: boolean, tagFilters: string[]): string[] {
    const raw = this.store.searchSemantic(space, this.embedder.embed(query), tagFilters.length ? limit * 10 : limit, includeDrafts);
    if (!tagFilters.length) return raw;
    return raw
      .map((id) => this.store.getNode(space, id))
      .filter((n) => n && tagFilters.every((t) => n.tags.includes(t)))
      .slice(0, limit)
      .map((n) => n!.id);
  }
  private nodesFor(space: string, ids: string[]): NodeSummary[] {
    return ids.map((id) => this.store.getNode(space, id)).filter(Boolean) as NodeSummary[];
  }
  tagCounts(space: string) {
    return this.store.tagCounts(space);
  }
  listNotes(space: string, limit = 50, includeDrafts = false, tagFilters: string[] = []): NodeSummary[] {
    return this.store.listNodes(space, limit, includeDrafts, tagFilters);
  }
  getAgentMode(space: string) {
    return this.store.getAgentMode(space);
  }
  setAgentMode(space: string, mode: "draft" | "open") {
    this.store.setAgentMode(space, mode);
  }
  getRequiredFacets(space: string) {
    return this.store.getRequiredFacets(space);
  }
  setRequiredFacets(space: string, facets: string[]) {
    this.store.setRequiredFacets(space, facets);
  }
  // Which required facets a note (with these tags) is missing. Exempt if tagged
  // `shared`, or if the note IS a facet node (tagged with a facet key itself).
  missingFacets(space: string, tags: string[]): string[] {
    const req = this.store.getRequiredFacets(space);
    if (!req.length || tags.includes("shared") || req.some((k) => tags.includes(k))) return [];
    return req.filter((key) => !tags.some((t) => t.startsWith(key + ":")));
  }
  neighbors(space: string, note: string, hops = 1, dir: "out" | "in" | "both" = "both") {
    return this.resolveScope(space, { focus: [note], hops, dir });
  }
  backlinks(space: string, note: string) {
    return this.runQuery(space, { note, kind: "backlinks" });
  }
  hasNote(space: string, note: string): boolean {
    return !!this.store.getNode(space, note);
  }
  ensureSpaceExists(space: string): void {
    this.store.ensureSpace(space);
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
      this.store.searchDelete(space, note);
      this.store.deleteEmbedding(space, note);
      return;
    }
    const title = getTitle(h);
    const body = h.body.toString();
    this.store.upsertNode(space, { id: note, title, tags: h.tags.toArray(), stub: !!h.meta.get("stub") });
    this.store.searchUpsert(space, note, title, body);
    this.store.upsertEmbedding(space, note, this.embedder.embed(`${title}\n${body}`));
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
