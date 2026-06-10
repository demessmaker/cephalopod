// SpaceHub — the brain's core. Owns authoritative Y.Docs (loaded lazily from the
// store's snapshot+log), persists every delta, snapshots periodically, maintains
// the server-derived graph index, resolves lazy-neighborhood scopes, and fans
// updates out to subscribed connections. Multi-space, with per-space isolation.
//
// Async over an AsyncStore (SQLite is lifted via asyncify; Postgres is native).
// Concurrency: WS messages are serialized per connection (CRDT sync order); writes
// take a per-doc lock (so the apply→check→rollback→commit critical section is
// atomic); getDoc has a load-guard (no double-load). Reads run lock-free.
import * as Y from "yjs";
import { handle, getTitle, type NoteHandle } from "./core/note.js";
import { deriveEdges, type EdgeRec } from "./core/wikilinks.js";
import { edgeId, stubId, newNoteId } from "./core/ids.js";
import {
  b64,
  docKey,
  splitDocKey,
  type ClientMsg,
  type ServerMsg,
  type Conn,
  type NodeSummary,
  type Scope,
  type GraphQuery,
} from "./core/protocol.js";
import { toAsync, type AsyncStore, type Store } from "./store/store.js";
import { HashingEmbedder, type Embedder } from "./embedder.js";
import { scanSecrets } from "./secrets.js";
import type { Capabilities } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";
import type { Broadcaster, BroadcastMsg } from "./broadcast.js";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

type ServerConn = Conn<ServerMsg, ClientMsg>;
type MaybeAsync<T> = T | Promise<T>;

// Cap on a single awareness (presence) payload — enough for cursor + small selection
// + user identity, but bounds the verbatim-relayed blob so it can't be an amplifier.
const MAX_AWARENESS_STATE = 16_384;

// A connection's access policy (built from token -> principal -> role by the
// ws-server; tests/internal callers use ALLOW_ALL). Predicates may be sync or
// async (an async store needs an await to resolve roles). `kind` lets the WS write
// path apply the same agent policy (draft-gate/facets/provenance) as HTTP.
export interface ConnAuth {
  canRead(space: string): MaybeAsync<boolean>;
  canWrite(space: string): MaybeAsync<boolean>;
  kind?: "agent" | "user";
  principalId?: string; // attributes log entries (for blame / revert)
  caps?: Capabilities; // capability scope (writeTags/pathPrefix) — enforced on WS writes too
}
export const ALLOW_ALL: ConnAuth = { canRead: () => true, canWrite: () => true };

interface ConnState {
  ch: ServerConn;
  open: Set<string>; // docKey()s this connection has open
  auth: ConnAuth;
  tail: Promise<unknown>; // per-connection serialization of message handling
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
  maxLoadedDocs?: number; // cap on in-memory docs (LRU-evict + snapshot beyond it); 0 = unlimited
  rateLimit?: { capacity: number; refillPerSec: number }; // per-principal WS message rate limit
  broadcaster?: Broadcaster; // C2: cross-instance fan-out (default: single-instance, none)
  maxBlobBytes?: number; // per-object attachment size cap (default 25 MiB)
  blobBudgetBytes?: number; // per-space total blob storage cap (0 = unlimited)
}

export type SearchMode = "text" | "semantic" | "hybrid";

export class SpaceHub {
  private store: AsyncStore;
  private docs = new Map<string, DocState>(); // insertion order == LRU order
  private conns = new Set<ConnState>();
  private snapshotEvery: number;
  private embedder: Embedder;
  private maxLoadedDocs: number;
  private maxBlobBytes: number;
  private blobBudgetBytes: number;
  private limiter?: RateLimiter;
  private awarenessLimiter?: RateLimiter; // separate, looser budget for ephemeral presence
  private broadcaster?: Broadcaster;
  private unsubscribe?: () => void; // tear down the broadcaster subscription on close()
  private remoteSeen = new Map<string, number>(); // per-doc high-water seq (dedup redelivery)
  private docLocks = new Map<string, Promise<unknown>>(); // per-doc write serialization
  private loading = new Map<string, Promise<DocState>>(); // in-flight loads (load-guard)

  constructor(store: Store | AsyncStore, opts: HubOptions = {}) {
    this.store = toAsync(store);
    this.snapshotEvery = opts.snapshotEvery ?? 50;
    this.embedder = opts.embedder ?? new HashingEmbedder();
    this.maxLoadedDocs = opts.maxLoadedDocs ?? 0;
    this.maxBlobBytes = opts.maxBlobBytes ?? 25 * 1024 * 1024;
    this.blobBudgetBytes = opts.blobBudgetBytes ?? 0;
    if (opts.rateLimit) {
      this.limiter = new RateLimiter(opts.rateLimit.capacity, opts.rateLimit.refillPerSec);
      // Presence is frequent, so it gets its own much larger bucket — but a bucket,
      // not a free pass: a malicious client can't drive unbounded fan-out/amplification.
      this.awarenessLimiter = new RateLimiter(Math.max(opts.rateLimit.capacity * 20, 200), Math.max(opts.rateLimit.refillPerSec * 20, 200));
    }
    this.broadcaster = opts.broadcaster;
    if (this.broadcaster) this.unsubscribe = this.broadcaster.subscribe((msg) => void this.onRemoteUpdate(msg));
  }

  // Release the broadcaster subscription (a torn-down hub must stop processing
  // messages and not leak a listener on the shared broker).
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // C2: a delta committed on another instance (sharing our store). The store is
  // already updated by the origin, so we don't persist or reindex — we only keep
  // our in-memory cache coherent (if the doc is resident) and fan out to the local
  // connections that hold it open, exactly as if it had been applied here.
  private async onRemoteUpdate(msg: BroadcastMsg): Promise<void> {
    if (msg.origin === this.broadcaster?.id) return; // skip our own publishes
    const key = docKey(msg.space, msg.note);
    const bytes = b64.dec(msg.update);
    // Apply + fan out under the doc lock so concurrent remote messages for the same
    // note deliver to clients in CRDT-causal (seq) order — matching the local path.
    await this.withDocLock(key, async () => {
      // A real broker can reorder or redeliver. Dedup on the store's monotonic log
      // seq: applying is idempotent in Yjs, but re-fanning would send clients a
      // duplicate `update` frame. Skip anything we've already seen.
      if (msg.seq <= (this.remoteSeen.get(key) ?? 0)) return;
      this.remoteSeen.set(key, msg.seq);
      const st = this.docs.get(key);
      if (st) Y.applyUpdate(st.doc, bytes, "remote");
      for (const conn of this.conns) {
        if (conn.open.has(key)) conn.ch.send({ t: "update", space: msg.space, note: msg.note, update: msg.update });
      }
    });
  }

  // Serialize writes to one doc (the apply→gate→rollback→commit section must be
  // atomic). Cleans up the map when a key's chain goes idle.
  private withDocLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.docLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.docLocks.set(key, tail);
    void tail.then(() => {
      if (this.docLocks.get(key) === tail) this.docLocks.delete(key);
    });
    return run;
  }

  addConnection(ch: ServerConn, auth: ConnAuth = ALLOW_ALL): ConnState {
    const conn: ConnState = { ch, open: new Set(), auth, tail: Promise.resolve() };
    this.conns.add(conn);
    // serialize per-connection so CRDT sync frames are processed in arrival order
    ch.onMessage((msg) => {
      conn.tail = conn.tail.then(() => this.handle(conn, msg)).catch(() => {});
    });
    return conn;
  }
  removeConnection(conn: ConnState): void {
    this.conns.delete(conn);
  }

  // Load a doc into memory from snapshot + log tail (rehydration), or create it.
  // Load-guarded: concurrent callers for the same key share one in-flight load.
  private async getDoc(space: string, note: string): Promise<DocState> {
    const key = docKey(space, note);
    const existing = this.docs.get(key);
    if (existing) {
      this.docs.delete(key); // LRU touch: re-insert moves it to the most-recent end
      this.docs.set(key, existing);
      return existing;
    }
    const inflight = this.loading.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const doc = new Y.Doc();
      const { snapshot, updates } = await this.store.loadDoc(space, note);
      if (snapshot) Y.applyUpdate(doc, snapshot.state, "load");
      for (const u of updates) Y.applyUpdate(doc, u, "load");
      const st: DocState = { doc, lastSeq: 0, sinceSnap: 0 };
      this.docs.set(key, st);
      // Refresh the derived index from loaded state, but don't index a note that
      // has never been written (a bare open/sync1 on a non-existent id) — that
      // would seed a phantom empty node and inflate quota counts.
      if (snapshot || updates.length) await this.reindex(space, note, doc);
      await this.evictColdDocs(key);
      return st;
    })();
    this.loading.set(key, p);
    try {
      return await p;
    } finally {
      this.loading.delete(key);
    }
  }

  // Bound resident memory: when over the cap, evict the least-recently-used docs
  // (snapshotting any with un-snapshotted writes first, so nothing is lost — they
  // rehydrate from snapshot+log on next access). Never evicts the just-loaded doc.
  private async evictColdDocs(keep: string): Promise<void> {
    if (this.maxLoadedDocs <= 0) return;
    while (this.docs.size > this.maxLoadedDocs) {
      const oldest = this.docs.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === keep) break;
      const st = this.docs.get(oldest)!;
      const [s, n] = splitDocKey(oldest);
      if (st.lastSeq > 0 && st.sinceSnap > 0) await this.snapshot(s, n, st);
      this.docs.delete(oldest);
    }
  }

  private deny(conn: ConnState, action: string, space: string): void {
    conn.ch.send({ t: "error", code: "scope_denied", message: `not allowed to ${action} ${space}` });
  }

  private async handle(conn: ConnState, msg: ClientMsg): Promise<void> {
    // Per-principal WS message rate limit (each update triggers a reindex, so the
    // write path is relatively expensive — don't let one principal flood it).
    // Awareness uses a separate, looser limiter (checked in its case below), not the
    // write-path one — presence is frequent but must still have a server-side ceiling.
    if (msg.t !== "awareness" && this.limiter && conn.auth.principalId && !this.limiter.allow(conn.auth.principalId)) {
      return conn.ch.send({ t: "error", code: "rate_limited", message: "rate limit exceeded" });
    }
    switch (msg.t) {
      case "awareness": {
        if (!(await conn.auth.canRead(msg.space))) return this.deny(conn, "read", msg.space);
        if (msg.state.length > MAX_AWARENESS_STATE) return; // drop oversized presence blobs (amplification guard)
        if (this.awarenessLimiter && conn.auth.principalId && !this.awarenessLimiter.allow(conn.auth.principalId)) return; // bounded fan-out
        // Ephemeral: fan out to the doc's other watchers; never touch the store.
        const key = docKey(msg.space, msg.note);
        for (const other of this.conns) {
          if (other === conn || !other.open.has(key)) continue;
          other.ch.send({ t: "awareness", space: msg.space, note: msg.note, state: msg.state });
        }
        break;
      }
      case "subscribe": {
        if (!(await conn.auth.canRead(msg.space))) return this.deny(conn, "read", msg.space);
        conn.ch.send({ t: "slice", id: msg.id, ...(await this.resolveScope(msg.space, msg.scope)) });
        break;
      }
      case "open": {
        if (!(await conn.auth.canRead(msg.space))) return this.deny(conn, "read", msg.space);
        await this.store.ensureSpace(msg.space);
        await this.getDoc(msg.space, msg.note);
        conn.open.add(docKey(msg.space, msg.note));
        break;
      }
      case "sync1": {
        if (!(await conn.auth.canRead(msg.space))) return this.deny(conn, "read", msg.space);
        const { doc } = await this.getDoc(msg.space, msg.note);
        conn.ch.send({ t: "sync2", space: msg.space, note: msg.note, update: b64.enc(Y.encodeStateAsUpdate(doc, b64.dec(msg.sv))) });
        conn.ch.send({ t: "sync1", space: msg.space, note: msg.note, sv: b64.enc(Y.encodeStateVector(doc)) });
        break;
      }
      case "sync2":
      case "update": {
        if (!(await conn.auth.canWrite(msg.space))) return this.deny(conn, "write", msg.space);
        await this.applyClientDelta(conn, msg.space, msg.note, b64.dec(msg.update), msg.update);
        break;
      }
      case "query": {
        if (!(await conn.auth.canRead(msg.space))) return this.deny(conn, "read", msg.space);
        conn.ch.send({ t: "result", id: msg.id, ...(await this.runQuery(msg.space, msg.q)) });
        break;
      }
    }
  }

  private applyClientDelta(conn: ConnState, space: string, note: string, bytes: Uint8Array, raw: string): Promise<void> {
    return this.withDocLock(docKey(space, note), async () => {
      // Quota is checked BEFORE the note is loaded, so we don't seed a phantom doc
      // or inflate the count (parity with the HTTP create path, which checks first).
      const existed = await this.hasNote(space, note);
      if (!existed && (await this.quotaExceeded(space))) {
        return this.denyWrite(conn, "quota_exceeded", `space "${space}" note quota reached`, note);
      }
      const st = await this.getDoc(space, note);
      // A CRDT delta can't be *rejected* after it's applied. For hard policy
      // violations (capability scope, secret-block) we apply, inspect the result,
      // and roll back to the pre-delta state — so nothing rejected is persisted or
      // fanned out. The pre-image is captured only when a rejection is possible.
      const caps = conn.auth.caps;
      const mayReject = !!(caps?.writeTags?.length || caps?.pathPrefix) || (await this.getSecretScan(space)) === "block";
      const before = mayReject ? Y.encodeStateAsUpdate(st.doc) : null;
      Y.applyUpdate(st.doc, bytes, conn); // origin = conn
      if (mayReject) {
        const violation = await this.writeViolation(conn, space, note);
        if (violation) {
          await this.rollbackWrite(space, note, st, before!, existed);
          return this.denyWrite(conn, violation.code, violation.message, note);
        }
      }
      await this.commit(space, note, st, bytes, raw, conn, conn.auth.principalId ?? "unknown");
      await this.enforceAgentWrite(conn, space, note); // N2: WS writes obey agent policy too
    });
  }

  // Hard write gates that mirror the HTTP path's `inScope` + secret-block, run
  // against the note's post-apply state. Returns the denial to send, or null.
  private async writeViolation(conn: ConnState, space: string, note: string): Promise<{ code: string; message: string } | null> {
    const caps = conn.auth.caps;
    const snap = await this.getNoteSnapshot(space, note);
    if (caps?.writeTags?.length && !caps.writeTags.some((t) => snap.tags.includes(t))) {
      return { code: "scope_denied", message: `token may only write notes tagged: ${caps.writeTags.join(", ")}` };
    }
    if (caps?.pathPrefix && !String(snap.props.path ?? "").startsWith(caps.pathPrefix)) {
      return { code: "scope_denied", message: `token scoped to path "${caps.pathPrefix}"` };
    }
    if ((await this.getSecretScan(space)) === "block" && scanSecrets(`${snap.title}\n${snap.body}\n${JSON.stringify(snap.props)}`).length > 0) {
      return { code: "secret_suspected", message: "possible secret detected — write rejected" };
    }
    return null;
  }

  // Undo an in-memory delta that violated a hard gate (it was never committed).
  private async rollbackWrite(space: string, note: string, st: DocState, before: Uint8Array, existed: boolean): Promise<void> {
    const key = docKey(space, note);
    if (existed) {
      const fresh = new Y.Doc();
      Y.applyUpdate(fresh, before, "load");
      st.doc = fresh;
      await this.reindex(space, note, fresh);
    } else {
      this.docs.delete(key);
      await this.store.deleteNode(space, note);
      await this.store.searchDelete(space, note);
      await this.store.deleteEmbedding(space, note);
      await this.store.replaceEdgesFrom(space, note, []);
    }
  }

  private denyWrite(conn: ConnState, code: string, message: string, note: string): void {
    conn.ch.send({ t: "error", code, message, ref: note });
  }

  // Post-apply *corrections* on committed WS writes (05 §4–5). Unlocked core: runs
  // inside applyClientDelta's doc lock.
  private async enforceAgentWrite(conn: ConnState, space: string, note: string): Promise<void> {
    const doc = this.docs.get(docKey(space, note))?.doc;
    if (!doc) return;
    const h = handle(note, doc);
    if (h.meta.get("deleted")) return;
    const tags = h.tags.toArray();
    const isAgent = conn.auth.kind === "agent";
    const needSecretTag =
      (await this.getSecretScan(space)) === "warn" &&
      !tags.includes("secret-suspected") &&
      scanSecrets(`${getTitle(h)}\n${h.body.toString()}\n${JSON.stringify(h.props.toJSON())}`).length > 0;
    const needStamp = isAgent && h.props.get("authoredBy") !== "agent";
    const needDraft = isAgent && (await this.getAgentMode(space)) === "draft" && !tags.includes("draft");
    const needFacets = isAgent && (await this.missingFacets(space, tags)).length > 0 && !tags.includes("needs-facets");
    if (!needSecretTag && !needStamp && !needDraft && !needFacets) return;
    await this._applyLocalEdit(space, note, (hh) => {
      if (needStamp) hh.props.set("authoredBy", "agent");
      const t = hh.tags.toArray();
      if (needSecretTag && !t.includes("secret-suspected")) hh.tags.push(["secret-suspected"]);
      if (needDraft && !t.includes("draft")) hh.tags.push(["draft"]);
      if (needFacets && !t.includes("needs-facets")) hh.tags.push(["needs-facets"]);
    });
  }

  // Shared persist + index + snapshot + fan-out path (unlocked core; callers hold
  // the doc lock). `actor` attributes the log entry (blame/revert).
  private async commit(space: string, note: string, st: DocState, bytes: Uint8Array, raw: string, except: ConnState | undefined, actor: string): Promise<void> {
    st.lastSeq = await this.store.appendUpdate(space, note, bytes, actor, Date.now()); // append-only log
    await this.reindex(space, note, st.doc); // refresh derived index + FTS
    if (++st.sinceSnap >= this.snapshotEvery) await this.snapshot(space, note, st);
    const key = docKey(space, note);
    for (const other of this.conns) {
      if (other === except || !other.open.has(key)) continue;
      other.ch.send({ t: "update", space, note, update: raw });
    }
    // C2: fan the delta out to other instances sharing our store (no-op single-node).
    // seq lets recipients dedup broker redelivery. Publish off the write path, but
    // surface broker errors (a swallowed failure means other instances silently
    // never see this delta) rather than dropping them.
    if (this.broadcaster) {
      Promise.resolve(this.broadcaster.publish({ origin: this.broadcaster.id, space, note, update: raw, seq: st.lastSeq })).catch((e) =>
        console.warn(`[broadcast] publish failed for ${space}/${note}: ${(e as Error).message}`),
      );
    }
  }

  // Apply a server-side edit (HTTP/MCP) through the same write path as WS deltas.
  // Unlocked core; public mutators wrap it in the doc lock.
  private async _applyLocalEdit(space: string, note: string, fn: (h: NoteHandle) => void, actor = "system"): Promise<void> {
    const st = await this.getDoc(space, note);
    let captured: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin === "http") captured = u;
    };
    st.doc.on("update", onUpdate);
    st.doc.transact(() => fn(handle(note, st.doc)), "http");
    st.doc.off("update", onUpdate);
    if (captured) await this.commit(space, note, st, captured, b64.enc(captured), undefined, actor);
  }

  // ---- HTTP/MCP command surface (03 §2) ----------------------------------

  async createNote(space: string, fields: NoteFields, id = newNoteId(), actor = "system"): Promise<string> {
    await this.store.ensureSpace(space);
    await this.withDocLock(docKey(space, id), () =>
      this._applyLocalEdit(space, id, (h) => {
        h.meta.set("createdAt", new Date().toISOString());
        if (fields.title !== undefined) h.meta.set("title", fields.title);
        if (fields.body) h.body.insert(0, fields.body);
        if (fields.tags) for (const t of fields.tags) h.tags.push([t]);
        if (fields.props) for (const [k, v] of Object.entries(fields.props)) h.props.set(k, v);
      }, actor),
    );
    return id;
  }

  patchNote(space: string, note: string, patch: NoteFields, actor = "system"): Promise<void> {
    return this.withDocLock(docKey(space, note), () =>
      this._applyLocalEdit(space, note, (h) => {
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
      }, actor),
    );
  }

  deleteNote(space: string, note: string, actor = "system"): Promise<void> {
    return this.withDocLock(docKey(space, note), () => this._applyLocalEdit(space, note, (h) => h.meta.set("deleted", true), actor));
  }
  linkNote(space: string, from: string, to: string, type: string | null = null, actor = "system"): Promise<void> {
    return this.withDocLock(docKey(space, from), () => this._applyLocalEdit(space, from, (h) => h.outLinks.set(edgeId(from, to, type), { to, type }), actor));
  }
  unlinkNote(space: string, from: string, to: string, type: string | null = null, actor = "system"): Promise<void> {
    return this.withDocLock(docKey(space, from), () => this._applyLocalEdit(space, from, (h) => h.outLinks.delete(edgeId(from, to, type)), actor));
  }

  async getNoteSnapshot(space: string, note: string): Promise<NoteSnapshot> {
    const h = handle(note, (await this.getDoc(space, note)).doc);
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

  async search(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): Promise<NodeSummary[]> {
    return this.nodesFor(space, await this.store.search(space, query, limit, includeDrafts, tagFilters));
  }
  async searchSemantic(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): Promise<NodeSummary[]> {
    return this.nodesFor(space, await this.semanticIds(space, query, limit, includeDrafts, tagFilters));
  }
  // Reciprocal-rank fusion of lexical (FTS) + semantic (vector) results (03 §3).
  async searchHybrid(space: string, query: string, limit = 20, includeDrafts = false, tagFilters: string[] = []): Promise<NodeSummary[]> {
    const [lex, sem] = await Promise.all([
      this.store.search(space, query, limit * 2, includeDrafts, tagFilters),
      this.semanticIds(space, query, limit * 2, includeDrafts, tagFilters),
    ]);
    const K = 60;
    const score = new Map<string, number>();
    const fuse = (ids: string[]) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (K + i)));
    fuse(lex);
    fuse(sem);
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
    return this.nodesFor(space, ranked);
  }
  searchMode(space: string, query: string, mode: SearchMode, limit = 20, includeDrafts = false, tagFilters: string[] = []): Promise<NodeSummary[]> {
    if (mode === "semantic") return this.searchSemantic(space, query, limit, includeDrafts, tagFilters);
    if (mode === "hybrid") return this.searchHybrid(space, query, limit, includeDrafts, tagFilters);
    return this.search(space, query, limit, includeDrafts, tagFilters);
  }
  // vector ids, post-filtered by facet tags (the store's vector scan has no tag clause)
  private async semanticIds(space: string, query: string, limit: number, includeDrafts: boolean, tagFilters: string[]): Promise<string[]> {
    const raw = await this.store.searchSemantic(space, await this.embedder.embed(query), tagFilters.length ? limit * 10 : limit, includeDrafts);
    if (!tagFilters.length) return raw;
    const nodes = await Promise.all(raw.map((id) => this.store.getNode(space, id)));
    return nodes.filter((n) => n && tagFilters.every((t) => n.tags.includes(t))).slice(0, limit).map((n) => n!.id);
  }
  private async nodesFor(space: string, ids: string[]): Promise<NodeSummary[]> {
    const nodes = await Promise.all(ids.map((id) => this.store.getNode(space, id)));
    return nodes.filter(Boolean) as NodeSummary[];
  }
  tagCounts(space: string) {
    return this.store.tagCounts(space);
  }
  listNotes(space: string, limit = 50, includeDrafts = false, tagFilters: string[] = []): Promise<NodeSummary[]> {
    return this.store.listNodes(space, limit, includeDrafts, tagFilters);
  }
  getAgentMode(space: string) {
    return this.store.getAgentMode(space);
  }
  setAgentMode(space: string, mode: "draft" | "open") {
    return this.store.setAgentMode(space, mode);
  }
  getRequiredFacets(space: string) {
    return this.store.getRequiredFacets(space);
  }
  setRequiredFacets(space: string, facets: string[]) {
    return this.store.setRequiredFacets(space, facets);
  }
  getMaxNotes(space: string) {
    return this.store.getMaxNotes(space);
  }
  setMaxNotes(space: string, max: number) {
    return this.store.setMaxNotes(space, max);
  }
  // true if a new note would exceed the space's quota (0 = unlimited)
  async quotaExceeded(space: string): Promise<boolean> {
    const max = await this.store.getMaxNotes(space);
    return max > 0 && (await this.store.countNotes(space)) >= max;
  }
  getSecretScan(space: string) {
    return this.store.getSecretScan(space);
  }
  setSecretScan(space: string, mode: "off" | "warn" | "block") {
    return this.store.setSecretScan(space, mode);
  }
  // Attachments / blob store (Track D). Content-addressed (blake3) and per-space, so
  // identical uploads dedupe and a blob can't leak across spaces. Returns the handle
  // a note's markdown references (e.g. `![](/v1/spaces/<s>/blobs/<hash>)`).
  async putBlob(space: string, bytes: Uint8Array, type: string): Promise<{ hash: string; size: number; type: string }> {
    if (bytes.byteLength === 0) throw new Error("empty blob");
    if (bytes.byteLength > this.maxBlobBytes) throw new Error(`blob exceeds ${this.maxBlobBytes}-byte limit`);
    await this.store.ensureSpace(space);
    const hash = "b_" + bytesToHex(blake3(bytes));
    // per-space storage budget — but a dedupe hit adds no bytes, so it's exempt
    if (this.blobBudgetBytes > 0 && !(await this.store.hasBlob(space, hash))) {
      if ((await this.store.blobBytes(space)) + bytes.byteLength > this.blobBudgetBytes) {
        throw new Error(`space blob budget exceeded (${this.blobBudgetBytes}-byte limit)`);
      }
    }
    await this.store.putBlob(space, hash, type, bytes);
    return { hash, size: bytes.byteLength, type };
  }
  getBlob(space: string, hash: string): Promise<{ type: string; bytes: Uint8Array } | undefined> {
    return this.store.getBlob(space, hash);
  }
  hasBlob(space: string, hash: string): Promise<boolean> {
    return this.store.hasBlob(space, hash);
  }
  deleteBlob(space: string, hash: string): Promise<void> {
    return this.store.deleteBlob(space, hash);
  }

  // Mark-and-sweep blob GC: delete every stored blob whose hash isn't referenced by
  // any live note in the space (notes reference blobs as `…/blobs/<hash>` in their
  // body markdown). Blobs are dedupe-shared and note delete/purge doesn't touch them,
  // so this is the safe way to reclaim orphans. Conservative — a hash appearing
  // anywhere in a note's title/body/props keeps the blob (we over-keep, never
  // over-delete). Admin-only; O(notes) — an occasional maintenance op, not per-write.
  async gcBlobs(space: string): Promise<{ scanned: number; deleted: number; kept: number }> {
    // List the candidate set FIRST, before scanning: a blob uploaded after this
    // point isn't a candidate, so a concurrent upload can't be raced into deletion
    // before its note lands. (A note created mid-scan that references a *pre-existing*
    // orphan can still be missed — run GC during a quiet window.)
    const hashes = await this.store.listBlobHashes(space);
    const referenced = new Set<string>();
    const BLOB_REF = /b_[0-9a-f]{6,}/g;
    for (const n of await this.store.listNodes(space, 1_000_000_000, true, [])) {
      const snap = await this.getNoteSnapshot(space, n.id);
      const text = `${snap.title}\n${snap.body}\n${JSON.stringify(snap.props)}`;
      for (const m of text.matchAll(BLOB_REF)) referenced.add(m[0]);
    }
    let deleted = 0;
    for (const h of hashes) {
      if (!referenced.has(h)) {
        await this.store.deleteBlob(space, h);
        deleted++;
      }
    }
    return { scanned: hashes.length, deleted, kept: hashes.length - deleted };
  }

  // Hard purge (05 §5): expunge a note everywhere + evict from memory.
  purgeNote(space: string, note: string): Promise<void> {
    return this.withDocLock(docKey(space, note), async () => {
      await this.store.purgeNote(space, note);
      this.docs.delete(docKey(space, note));
    });
  }

  // Reversibility (05 §4): undo a principal's edits to a note since `sinceTs` by
  // replaying the retained log tail WITHOUT those deltas, then overwriting the live
  // doc with the reconstructed "clean" content. History-preserving.
  // Limitation: only edits still in the un-compacted tail can be dropped; if a
  // snapshot folded in edits at/after sinceTs, the result is flagged `partial`.
  private revertNote(space: string, note: string, actor: string, sinceTs: number): Promise<{ changed: boolean; partial: boolean }> {
    return this.withDocLock(docKey(space, note), async () => {
      const { snapshot, updates } = await this.store.loadDocMeta(space, note);
      const clean = new Y.Doc();
      if (snapshot) Y.applyUpdate(clean, snapshot.state, "load");
      let changed = false;
      for (const u of updates) {
        if (u.actor === actor && u.ts >= sinceTs) {
          changed = true;
          continue; // drop this delta
        }
        Y.applyUpdate(clean, u.bytes, "load");
      }
      const partial = !!snapshot && (snapshot.coversTs ?? 0) >= sinceTs;
      if (!changed) return { changed: false, partial };
      const c = handle(note, clean);
      await this._applyLocalEdit(
        space,
        note,
        (h) => {
          h.meta.set("title", (c.meta.get("title") as string) ?? "");
          h.meta.set("deleted", !!c.meta.get("deleted"));
          h.body.delete(0, h.body.length);
          h.body.insert(0, c.body.toString());
          h.tags.delete(0, h.tags.length);
          for (const t of c.tags.toArray()) h.tags.push([t]);
          const want = c.props.toJSON() as Record<string, unknown>;
          for (const k of [...h.props.keys()]) if (!(k in want)) h.props.delete(k);
          for (const [k, v] of Object.entries(want)) h.props.set(k, v);
          for (const k of [...h.outLinks.keys()]) if (!c.outLinks.has(k)) h.outLinks.delete(k);
          for (const [k, v] of c.outLinks.entries()) h.outLinks.set(k, v);
        },
        "revert",
      );
      return { changed: true, partial };
    });
  }

  async revertActor(space: string, actor: string, sinceTs: number): Promise<{ reverted: string[]; partial: string[] }> {
    const reverted: string[] = [];
    const partial: string[] = [];
    for (const note of await this.store.notesTouchedBy(space, actor, sinceTs)) {
      const r = await this.revertNote(space, note, actor, sinceTs);
      if (!r.changed) continue;
      reverted.push(note);
      if (r.partial) partial.push(note);
    }
    return { reverted, partial };
  }
  // Which required facets a note (with these tags) is missing. Exempt if tagged
  // `shared`, or if the note IS a facet node (tagged with a facet key itself).
  async missingFacets(space: string, tags: string[]): Promise<string[]> {
    const req = await this.store.getRequiredFacets(space);
    if (!req.length || tags.includes("shared") || req.some((k) => tags.includes(k))) return [];
    return req.filter((key) => !tags.some((t) => t.startsWith(key + ":")));
  }
  neighbors(space: string, note: string, hops = 1, dir: "out" | "in" | "both" = "both") {
    return this.resolveScope(space, { focus: [note], hops, dir });
  }
  backlinks(space: string, note: string) {
    return this.runQuery(space, { note, kind: "backlinks" });
  }
  async hasNote(space: string, note: string): Promise<boolean> {
    return !!(await this.store.getNode(space, note));
  }
  ensureSpaceExists(space: string): Promise<void> {
    return this.store.ensureSpace(space);
  }

  private async snapshot(space: string, note: string, st: DocState): Promise<void> {
    await this.store.saveSnapshot(space, note, Y.encodeStateAsUpdate(st.doc), st.lastSeq);
    st.sinceSnap = 0;
  }

  // Flush snapshots for all loaded docs (call on graceful shutdown).
  async snapshotAll(): Promise<void> {
    for (const [key, st] of this.docs) {
      const [space, note] = splitDocKey(key);
      if (st.lastSeq > 0) await this.snapshot(space, note, st);
    }
  }

  // ---- derived graph index (02 §2.2) -------------------------------------

  private async resolveTitleAsync(space: string, titleOrId: string): Promise<string> {
    if (titleOrId.startsWith("n_")) return titleOrId;
    const found = await this.store.findIdByTitle(space, titleOrId.toLowerCase());
    if (found) return found;
    const id = stubId(titleOrId);
    if (!(await this.store.getNode(space, id))) {
      await this.store.upsertNode(space, { id, title: titleOrId, tags: [], stub: true });
    }
    return id;
  }

  private async reindex(space: string, note: string, doc: Y.Doc): Promise<void> {
    const h = handle(note, doc);
    if (h.meta.get("deleted")) {
      await this.store.deleteNode(space, note);
      await this.store.replaceEdgesFrom(space, note, []);
      await this.store.searchDelete(space, note);
      await this.store.deleteEmbedding(space, note);
      return;
    }
    const title = getTitle(h);
    const body = h.body.toString();
    await this.store.upsertNode(space, { id: note, title, tags: h.tags.toArray(), stub: !!h.meta.get("stub") });
    await this.store.searchUpsert(space, note, title, body);
    // A real embedder (ApiEmbedder) is a remote call that can time out / error /
    // return a bad vector. Never let that fail the write or de-sync the rest of the
    // derived index (node/FTS/edges) — degrade semantic search for this one note;
    // it re-embeds on the next edit or rehydrate.
    try {
      await this.store.upsertEmbedding(space, note, await this.embedder.embed(`${title}\n${body}`));
    } catch (err) {
      console.warn(`[reindex] embedding skipped for ${space}/${note}: ${(err as Error).message}`);
    }
    // Wikilink targets need async resolution (title->id, stub creation). Resolve
    // the distinct raw targets first, then derive edges with a sync map lookup.
    const raw = deriveEdges(note, body, (t) => t);
    const resolved = new Map<string, string>();
    for (const e of raw) if (!resolved.has(e.to)) resolved.set(e.to, await this.resolveTitleAsync(space, e.to));
    const derived = deriveEdges(note, body, (t) => resolved.get(t) ?? t);
    const explicit: EdgeRec[] = [...h.outLinks.values()].map((v) => ({ from: note, to: v.to, type: v.type ?? null, origin: "explicit" as const }));
    await this.store.replaceEdgesFrom(space, note, [...explicit, ...derived]);
  }

  // ---- scope & queries ---------------------------------------------------

  async resolveScope(space: string, s: Scope): Promise<{ nodes: NodeSummary[]; edges: EdgeRec[] }> {
    const dir = s.dir ?? "both";
    const seen = new Set(s.focus);
    let frontier = [...s.focus];
    const picked = new Map<string, EdgeRec>();
    for (let h = 0; h < s.hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of await this.store.edgesAdjacent(space, id, dir)) {
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
    return { nodes: await this.nodesFor(space, [...seen]), edges: [...picked.values()] };
  }

  private async runQuery(space: string, q: GraphQuery): Promise<{ nodes: NodeSummary[]; edges: EdgeRec[] }> {
    if (q.kind === "backlinks") {
      const edges = await this.store.edgesAdjacent(space, q.note, "in");
      const ids = new Set([q.note, ...edges.map((e) => e.from)]);
      return { nodes: await this.nodesFor(space, [...ids]), edges };
    }
    return this.resolveScope(space, { focus: [q.note], hops: q.hops ?? 1, dir: q.dir ?? "both" });
  }

  // ---- test/inspection ---------------------------------------------------
  async docState(space: string, note: string): Promise<Y.Doc> {
    return (await this.getDoc(space, note)).doc;
  }
}
