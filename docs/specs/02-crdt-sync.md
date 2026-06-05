# Cephalopod — CRDT & Sync

This is the heart of the system: how a freeform graph stays convergent across
many offline-capable replicas (arms) coordinated by a central brain.

## 1. Why CRDT

Two developers (or a developer and an agent) may edit the same note, or add
conflicting links, at the same time — possibly while offline. We require:

- **No hard conflicts.** Every replica that has seen the same set of updates
  reaches the same state, with no user-facing merge resolution.
- **Offline-first.** Edits apply locally and sync opportunistically.
- **Small deltas.** Changes ship as compact binary diffs, not whole documents.

CRDTs give us strong eventual consistency for exactly this.

### Library choice

**Recommendation: Yjs.** Rationale:

- Mature, fast, small deltas; battle-tested rich-text (`Y.Text`/`Y.XmlFragment`).
- Rich ecosystem: `y-websocket`, `y-indexeddb`, awareness protocol, ProseMirror/
  CodeMirror bindings for the future editor.
- Pluggable persistence (LevelDB/SQLite/`y-leveldb` server-side).

Automerge is the main alternative (richer history/columnar storage, Rust core).
We default to Yjs for rich-text maturity and ecosystem; the sync protocol below
is library-agnostic enough to swap. **Open question OQ-1** in `06-roadmap.md`.

## 2. Document decomposition

We do **not** put the whole space in one CRDT document — that would force every
arm to sync everything and kills partial caching. Instead:

### 2.1 Per-note documents

Each note is its own CRDT document (`Y.Doc`), keyed by note `id`:

| Field | CRDT type | Notes |
|-------|-----------|-------|
| `body` | `Y.XmlFragment` | rich-text (markdown ⇄ ProseMirror schema) |
| `title` | `Y.Text` | short text |
| `tags` | `Y.Array<string>` as a set | add/remove, dedup on read |
| `props` | `Y.Map` | freeform key→value (LWW per key) |
| `outLinks` | `Y.Map` | **explicit** outgoing edges keyed by edge id (§01-2.3) → `{ to, type, props }`; OR-Set semantics |
| `meta` | `Y.Map` | createdAt/By, stub flag, etc. |

Concurrent edits to *different* fields merge cleanly; concurrent edits to the
*same* scalar (e.g. two renames of `title`) resolve by Yjs's deterministic
ordering (effectively last-writer-wins, but identical on all replicas).

**Edges live with their source note.** Explicit edges (`link()` via API/MCP) are
stored in the source note's `outLinks` map, so they sync conflict-free with the
note and need no global edge document. Wikilink edges are *derived* from `body`
(deterministic edge ids, §01-2.3) and are not stored separately at all — they are
recomputed wherever the note doc is held.

### 2.2 The graph index is server-derived (not one CRDT doc)

> **Scale decision (resolves OQ-2).** At the v1 target of **~250k notes/space**
> (and ~1M+ edges), a single denormalized graph-index CRDT document would be
> hundreds of MB — too large to sync into every arm or hold hot per connection.
> So there is **no monolithic index document**. The queryable adjacency is a
> **server-derived index**, and the only authoritative graph state is the set of
> per-note CRDT docs.

The brain maintains, per space, a derived index (Postgres — `04 §2.4`) built by
processing per-note doc updates:

| Index | Contents | Source |
|-------|----------|--------|
| `nodes` | `id, title, tags, props, stub, updatedAt` | note doc fields |
| `edges` | `from, to, type, origin` (+ reverse for backlinks) | `outLinks` (explicit) + wikilinks parsed from `body` |

- This index is **rebuildable** from the per-note docs / update log; losing it is
  non-fatal. It is *not* synced as CRDT state.
- Backlinks come from the index's reverse edge table — a note doc alone does not
  know its inbound edges.
- Concurrency/convergence still holds because the *sources* are CRDT: explicit
  edges are OR-Set entries in the source note's `outLinks`; wikilink edges are a
  deterministic function of converged note bodies.

### 2.3 What an arm caches vs. asks the server

- An arm holds full CRDT **note docs** only for its working set (notes it opened
  or that match its scope).
- **Traversal/search/backlinks within the cached working set** are answered
  locally (the arm has those notes' bodies + `outLinks`).
- **Traversal/search beyond the cache** goes to the server's derived index via
  lazy-neighborhood streaming (§3.3, `03 §2.2`) — the arm never needs the whole
  graph to explore part of it.
- Offline, an arm can only traverse what it cached; exploring further requires
  reconnecting. This matches the "cache the subgraph you're working on" model.

## 3. Subgraph caching (the "working set")

An arm declares interest in a **scope**, and the brain streams the matching
documents + future deltas.

### 3.1 Scope definition

A scope is any of, combined:

- **Explicit set**: a list of note ids ("these 12 notes").
- **Neighborhood**: N-hop expansion from focus nodes (e.g. "Billing Service +
  2 hops of `depends_on`").
- **Query**: tag/property/full-text predicate ("all `#runbook` notes").
- **Namespace/folder**: a path prefix convention in `props.path`.

Scopes are *live*: as the graph changes, notes entering/leaving the scope are
streamed in/out. The arm pins explicitly-opened notes so they aren't evicted.

### 3.2 Sync protocol (per document)

Standard CRDT state-vector exchange, transport over a WebSocket multiplexing
many documents:

```
client → server:  SUBSCRIBE {scope}
server → client:   SYNC_STEP1 {doc, stateVector}      (for each doc in scope)
client → server:   SYNC_STEP2 {doc, diff vs server SV}
server → client:   SYNC_STEP2 {doc, diff vs client SV}
... steady state ...
either direction:  UPDATE {doc, deltaBytes}           (CRDT update = the "delta")
```

- A **delta** is a Yjs update (binary). Clients batch/debounce local updates
  (~200ms) before pushing to keep them small and reduce chatter.
- The server applies each delta to its authoritative copy, persists it (§4), and
  fans it out to all other subscribed arms.
- Server is a **relay + store**, not a CRDT authority that can reject merges —
  it cannot "lose"; it can only *refuse* (auth) before applying (§5, security).

### 3.3 Resolving a scope at 250k-note scale

Because there is no monolithic index doc (§2.2), the brain resolves a scope
**server-side** against its derived index and streams only what matches:

1. **Resolve** — evaluate the scope predicate (ids / N-hop neighborhood / query /
   path prefix) against the server index to a concrete set of note ids.
2. **Stream index slice** — send the lightweight node/edge records for that set
   as an ephemeral, read-mostly **sub-index** the arm caches for traversal UI.
3. **Stream note docs** — open CRDT sync (§3.2) for the notes the arm actually
   pins/opens (not every note in the slice).
4. **Stay live** — as the graph changes, notes entering/leaving the scope are
   pushed/evicted; the arm pins opened notes so they aren't dropped.

This makes **lazy-neighborhood loading the v1 mechanism**, not a later option.
Path-prefix (`props.path`) is just one scope predicate, not a separate sharding
scheme. The server index itself is sharded/partitioned as a storage concern in
`04 §4` (and a dedicated graph store remains OQ-4 if traversal latency demands).

### 3.4 Offline & reconnection

- Local persistence (`y-indexeddb` in browser/agent runtimes, `y-leveldb`/SQLite
  on disk for CLI/daemon arms) keeps the working set across restarts.
- Edits made offline are applied locally immediately and queued.
- On reconnect, the state-vector exchange (§3.2) ships exactly the missing
  updates in both directions. Convergence is guaranteed regardless of order.
- **Awareness** (presence, cursors, "agent X is editing") uses Yjs's ephemeral
  awareness channel — not persisted, not part of document state.

## 4. Persistence & history on the brain

The brain stores, per space:

1. **Append-only update log** — every CRDT delta, with `{actor, ts, doc, bytes}`.
   This is the source of truth and the audit trail (`05-security.md`).
2. **Materialized snapshots** — periodic compacted `Y.Doc` state per document,
   so a new arm syncs from a snapshot + tail rather than replaying all history.
3. **Derived indexes** (rebuildable): the graph adjacency/backlink index (§2.2)
   plus full-text, tag, and vector indexes (`03-api-mcp.md §3`). Never
   authoritative.

Time-travel/blame is served by replaying the log up to a timestamp or by Yjs
snapshots. Retention/compaction policy is OQ-3.

## 5. Deletion & tombstones

- Deleting a note sets a tombstone in the note doc itself (`meta.deleted`); the
  note doc's content CRDT retains tombstoned items so late-arriving edits from an
  offline arm don't resurrect content inconsistently. The server index drops the
  node on processing the tombstone.
- Deleting an **explicit** edge removes it from the source note's `outLinks`
  OR-Set (remove-wins within the same causal context; a concurrent re-add wins by
  default — add-wins — to avoid silently dropping a link someone is actively
  making). Configurable per space. A **wikilink** edge disappears when the link
  is removed from the body and the derived edge is recomputed.
- **Hard purge** (GDPR/secret leakage) is an out-of-band admin op that rewrites
  the log + snapshots and force-resyncs arms. Rare, audited.

## 6. Consistency guarantees (summary)

| Property | Guarantee |
|----------|-----------|
| Convergence | Any two arms with the same delta set are byte-identical. |
| Liveness | Online arms see each other's edits within ~one batch interval. |
| Offline | Edits never lost; merged on reconnect without user action. |
| Causality | Per-document causal order preserved by Yjs; cross-doc is not totally ordered (acceptable for freeform graph). |
| Durability | Acknowledged deltas are in the append-only log before fan-out. |

## 7. Known hard edges

- **Cross-document invariants** (e.g. "edge endpoints must exist") cannot be
  enforced atomically across separate CRDT docs. We treat dangling endpoints as
  *stubs* (§01-2.2), reconciled by the indexer, never as errors.
- **Concurrent title rename + title-based link** is resolved by binding links to
  `id` at creation (§01-2.2), so renames never break links.
- **Large binary embeds** are out of scope for the CRDT path — store as blobs
  referenced by URL in `props`, not in document state.
