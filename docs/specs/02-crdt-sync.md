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
| `meta` | `Y.Map` | createdAt/By, stub flag, etc. |

Concurrent edits to *different* fields merge cleanly; concurrent edits to the
*same* scalar (e.g. two renames of `title`) resolve by Yjs's deterministic
ordering (effectively last-writer-wins, but identical on all replicas).

### 2.2 The graph index document

Per space there is one **graph index** CRDT document holding lightweight node
and edge records — the connective tissue, *not* note bodies:

| Map | Key | Value |
|-----|-----|-------|
| `nodes` | note `id` | `{ title, tags, stub, updatedAt }` (denormalized stub) |
| `edges` | edge `id` (§01-2.3) | `{ from, to, type, origin }` |

- Edges are stored in an **OR-Set** style map keyed by deterministic edge id, so
  concurrent creation of the same logical edge converges to one entry, and
  add/remove races resolve predictably (add-wins by default, configurable).
- The index is small per node (~a few hundred bytes), so an arm can cache the
  index for its working set — or, for big spaces, a **partition** of it (§3.3).

### 2.3 Why split body vs index

- Traversal/search needs only the index → cheap to cache broadly.
- Editing needs the note doc → fetched on demand for notes you open.
- An arm caching "the auth subgraph" pulls the relevant index partition + the
  note docs it actually opens, not every byte of every note.

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

### 3.3 Partitioning the graph index for large spaces

For spaces with very large indexes, a single index doc is too big to cache
whole. Options (decision OQ-2):

- **Shard by namespace/path prefix** — arm caches only the shards intersecting
  its scope.
- **Lazy neighborhood loading** — server computes the N-hop closure server-side
  and streams only those node/edge records as a synthetic sub-index doc.

v1 default: single index doc up to a soft size cap, then path-prefix sharding.

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
3. **Derived indexes** (rebuildable): full-text, tag, and vector indexes
   (`03-api-mcp.md §3`). Never authoritative.

Time-travel/blame is served by replaying the log up to a timestamp or by Yjs
snapshots. Retention/compaction policy is OQ-3.

## 5. Deletion & tombstones

- Deleting a note writes a tombstone in the graph index (`nodes[id].deleted`)
  and clears/closes the note doc; the note doc's content CRDT retains tombstoned
  items so late-arriving edits from an offline arm don't resurrect content
  inconsistently.
- Deleting an edge removes it from the OR-Set (remove-wins only within the same
  causal context; a concurrent re-add wins by default — add-wins — to avoid
  silently dropping a link someone is actively making). Configurable per space.
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
