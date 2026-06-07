# Cephalopod — Architecture (as built)

This is the authoritative **as-built** reference for the system: components, data
model, request/sync flows, the storage and scale layers, security, and operations.
For design rationale and history see [`docs/specs/`](docs/specs/) (esp.
[04-architecture](docs/specs/04-architecture.md), [02-crdt-sync](docs/specs/02-crdt-sync.md),
[05-security](docs/specs/05-security.md)); for the post-Phase-1 work that shipped on
top, see [09-next-steps](docs/specs/09-next-steps.md).

The metaphor: a central **brain** (the authoritative graph) plus many semi-autonomous
**arms** (local replicas — a CLI, an editor, an agent) that cache a subgraph, edit
offline, and stream conflict-free **deltas** back.

---

## 1. Components

| Package | Role |
|---------|------|
| **`core/`** | Single source of truth shared by `brain` + `arm`: note schema (`note.ts`), ids (`ids.ts`), wikilink derivation (`wikilinks.ts`), wire protocol (`protocol.ts`). Brain/arm re-export it via thin `src/core/*` shims. |
| **`brain/`** | The server. Owns authoritative Y.Docs, the append-only log + snapshots, the derived graph index, search, auth, the HTTP API, the WS sync relay, blob store, importer/exporter, and ops endpoints. |
| **`mcp/`** | Model Context Protocol server — the agent-facing surface: tools (`create_note`, `search`, `neighbors`, …), note **resources** with live `resources/updated` subscriptions, and guided **prompts**. Talks to the brain over HTTP+WS with an agent token. |
| **`arm/`** | A developer's local replica (CLI): offline disk cache, edit-offline → reconnect → sync, pull-a-scope. The reference Yjs client the browser editor mirrors. |
| **`web/`** | Build-less graph explorer: search → force-directed subgraph → click-to-expand → live refresh, plus in-browser collaborative editing (Yjs + presence). Serves static assets and reverse-proxies `/v1` to the brain. |
| **`spike/`** | Frozen M0 convergence prototype (validated Yjs + lazy-neighborhood at 250k nodes). Not part of the running system. |

```
            ┌─────────── arms / clients ───────────┐
   CLI arm   MCP server   Web explorer   any HTTP client
      │           │            │ (HTTP /v1 proxy)   │
      │  WS+HTTP   │  WS+HTTP   │ WS direct          │ HTTP
      └─────┬──────┴─────┬──────┴──────────┬─────────┘
            ▼            ▼                 ▼
   ┌──────────────────────────────────────────────────┐
   │                    brain                          │
   │  HTTP API  ·  WS relay  ·  SpaceHub  ·  Auth      │
   │  search (FTS + vector)  ·  blob store  ·  metrics │
   └───────────────────────┬──────────────────────────┘
                           ▼
                    Store (SQLite | Postgres)
        log + snapshots · derived index · FTS · vectors
            principals/tokens/roles · settings · blobs
```

---

## 2. Data model

A **note** is a per-note Yjs document (`core/note.ts`):

- `body` — `Y.Text` (character-merging collaborative text).
- `title` — an **LWW** field in the `meta` `Y.Map` (*not* `Y.Text`: titles shouldn't character-merge).
- `tags` — `Y.Array<string>`; `props` — `Y.Map` (arbitrary metadata, incl. `path`, `authoredBy`, `aliases`).
- `outLinks` — `Y.Map` of explicit edges; `meta` also holds `createdAt`, `deleted`, `stub`.

Edges are **derived**, not stored in a monolithic CRDT index (which wouldn't scale to
~250k notes): the brain parses `[[wikilinks]]` from each note's body and maintains a
server-side **graph index** (`nodes` + `edges` tables). Unresolved links mint a
**stub** node. Traversal (`neighbors`, `backlinks`, scope resolution) runs against this
index without loading note docs — *lazy neighborhood*.

---

## 3. The brain

### 3.1 SpaceHub (`brain/src/hub.ts`)

The core. Multi-space, per-space isolation. Responsibilities:

- **Authoritative docs** — loads each Y.Doc lazily from `snapshot + log tail`, caches
  it (LRU-bounded, `maxLoadedDocs`), snapshots every N updates, and evicts cold docs.
- **Persistence** — every delta is appended to the log with `actor` + `ts` (for
  blame/revert); snapshots compact the tail.
- **Derived index** — on each write, re-derives nodes/edges/FTS/embedding (`reindex`).
- **Scope/queries** — `resolveScope` (BFS over the edge index), `backlinks`.
- **Fan-out** — pushes updates to subscribed connections; optionally to other
  instances via the `Broadcaster` (§6).
- **Command surface** — `createNote`/`patchNote`/`deleteNote`/`linkNote`/… funnel
  through the same write path as WS deltas, so HTTP/MCP and live editors converge.

### 3.2 Concurrency model

The hub is async (over an `AsyncStore`) and guards three hazards:

- **Per-connection serialization** — WS messages from one connection process in
  arrival order (`conn.tail` promise chain), preserving CRDT sync ordering.
- **Per-doc write lock** (`withDocLock`) — the `apply → gate → rollback → commit`
  critical section is atomic per note, so capability/secret gates can roll back an
  applied-but-rejected delta before it's persisted or fanned out.
- **Load guard** — concurrent first-touch loads of the same doc share one in-flight
  promise (no double-load).

### 3.3 Storage layer (`brain/src/store/`)

- **`Store`** — synchronous interface (the live default). Implemented by
  **`SqliteStore`** (better-sqlite3, WAL, FTS5, online `.backup()`).
- **`AsyncStore`** — a TypeScript *mapped type* mirror of `Store` returning Promises.
  **`PgStore`** (Postgres / PGlite) implements it natively; a sync store is lifted via
  `asyncify()`/`toAsync()`. The hub/auth/http accept either backend.
- **Migrations** (`migrations.ts`) — ordered, recorded (`schema_migrations`); v1
  baseline, v2 blobs. Postgres uses connection-scoped transactions (`pool.connect()`
  per txn) and binds `bytea` as `Buffer`.
- Backend parity is enforced by a conformance suite run against **both** SQLite and
  PGlite.

---

## 4. Protocol, APIs, sync

### 4.1 Wire protocol (`core/protocol.ts`)

Client → server: `subscribe`, `open`, `sync1` (state vector), `sync2`/`update`
(deltas), `awareness` (ephemeral presence), `query`. Server → client: `slice`,
`sync1`/`sync2`/`update`, `awareness`, `result`, `error`.

**Sync handshake** (the arm and browser editor both implement it): `open` → `sync1(sv)`
→ server replies `sync2(diff)` + `sync1(sv)` → client replies `sync2(diff)`; thereafter
local edits emit `update` deltas, applied remotely with origin tracking to avoid echo.

### 4.2 HTTP API (`brain/src/http.ts`)

`/v1/spaces/...` for spaces, notes, search, neighbors, query, tags, revert, purge, and
**blobs**. Every route is ACL-checked; auth + rate-limit run **before** body buffering.
Bodies are buffered as raw bytes (binary-safe) and JSON-parsed only for JSON types.
Unauthenticated `/healthz` and `/metrics`.

### 4.3 WS relay (`brain/src/server.ts`)

Authenticates via `Authorization` header / `bearer` subprotocol / `?token=` fallback,
builds a per-connection `ConnAuth` (role + capabilities + principal kind), and attaches
the socket to the hub. Carries the principal `kind` so agent policy applies to WS
writes too.

### 4.4 Search

- **FTS** — SQLite FTS5 / Postgres `tsvector`.
- **Semantic** — vectors via a pluggable **`Embedder`** (default dependency-free
  `HashingEmbedder`; `ApiEmbedder` calls any OpenAI-compatible `/embeddings`). Stored
  as `bytea`/BLOB, scored in JS. The hub awaits the embedder **fault-tolerantly** — an
  embed failure degrades semantic search for that note without failing the write.
- **Hybrid** — reciprocal-rank fusion of FTS + vector results.

---

## 5. Security & agent safety

See [05-security](docs/specs/05-security.md). Principals (`user`/`agent`), hashed
**tokens** (a principal may hold several), per-space **roles** (`viewer`/`editor`/`admin`).

- **Capability-scoped tokens** intersect with the role and only *narrow* it:
  `mode:"read"`, `writeTags`, `pathPrefix` — enforced on HTTP and WS.
- **Agent gating** — in draft-mode spaces an agent's writes are forced to `#draft`,
  stamped `authoredBy:agent`, and facet-less notes quarantined (`#needs-facets`),
  including post-hoc on WS deltas.
- **Bounds** — per-token HTTP rate limit, per-principal WS message limit (presence has
  its own looser limiter + size cap), per-space **note quota** and **blob budget**.
- **Screening** — write-time secret-scan (`off|warn|block`).
- **Reversibility** — `purge` (the one destructive op, admin-only, audited) and
  `revert` (replay the retained log tail minus an actor's deltas since T).

---

## 6. Scale (SaaS)

- **Postgres backend** — `PgStore` over the `AsyncStore` seam (native FTS, `bytea`
  vectors/blobs; add `pgvector` + ANN at scale).
- **Horizontal sharding** — a **`Broadcaster`** seam fans every committed delta to
  other brain instances sharing one store; on receipt a hub keeps its resident doc
  coherent and re-fans to its local connections under the doc lock, deduped by store
  `seq`, never re-persisting/-broadcasting. Default is single-instance; a `LocalBus`
  stands in for a real broker (NATS / Redis / Postgres LISTEN-NOTIFY).
- **Embeddings** — the `Embedder` seam routes to a real model behind the network.

---

## 7. Attachments (blob store)

Content-addressed (blake3), **per-space** blobs behind the `Store` contract
(`putBlob`/`getBlob`/`hasBlob`/`deleteBlob`/`blobBytes`). `POST /spaces/:s/blobs`
(write-gated, returns `{hash,size,type,url}`), `GET` (read-gated, byte-exact), admin
`DELETE`. Downloads are **XSS-hardened**: the stored content-type is honored only for
an inline-safe image allowlist (SVG excluded), everything else is `attachment` +
`octet-stream`, always with `nosniff`. A per-space **blob budget** bounds disk use. The
Obsidian importer's `upload` mode stores referenced files and rewrites `![[img]]` →
`![](…/blobs/<hash>)`.

---

## 8. Obsidian integration (`brain/src/import/`)

- **Import** — two-pass, idempotent: files → notes, frontmatter → tags/props,
  `[[wikilinks]]`/`![[embeds]]` → edges, attachments link/skip/upload. Symlink-safe.
- **Export** — the inverse: notes → Markdown (frontmatter + body, id-links → titles),
  incremental via a content-hash sync manifest.
- **Bidirectional sync** — a per-note three-way reconcile by content hash: propagates
  vault-only and brain-only edits, creates both directions, and resolves both-sides
  conflicts by policy (default brain-wins, the vault copy preserved under
  `.cephalopod/conflicts/`). Vault and brain hashes are tracked independently (CRLF
  -tolerant) so a settled tree re-syncs as a no-op. All writes are vault-contained.

---

## 9. Web explorer & live editing (`web/`)

Build-less ES modules; Yjs + `y-protocols` load in the browser from a CDN **import map**
(tests resolve the same specifiers from `node_modules`). The explorer searches and
renders a force-directed subgraph; an **Edit** toggle opens a CRDT `NoteSession`
(mirroring the arm's handshake) bound to a `<textarea>` via a surrogate-safe minimal
diff, with a live **presence** bar driven by the ephemeral `awareness` relay. The
server (`serve.mjs`, pure Node stdlib) serves assets and proxies `/v1` to the brain.

---

## 10. Operations

### Deployment

`docker compose up --build` runs the full stack:

| Service | Port | Notes |
|---------|------|-------|
| `brain` | 7700 (WS), 7701 (HTTP) | data in the `cephalopod-data` volume; non-root; healthchecked |
| `web` | 8080 | serves the explorer, proxies `/v1` → `brain` (in-network); healthchecked |

The brain prints a one-time bootstrap admin token on first start
(`docker compose logs brain | grep "bootstrap admin token"`). Open the explorer at
`http://localhost:8080`. Both Dockerfiles are multi-stage / dependency-lean and run as
the unprivileged `node` user.

### Observability

- **`/healthz`** — liveness (brain + web), wired into Docker/k8s healthchecks.
- **`/metrics`** — Prometheus text (request totals by status class, uptime, RSS).
- **Structured request logging** — one JSON line per request (method, path, status,
  ms — no query string, headers, token, or body); on by default, silence with
  `CEPH_LOG=0`.

> **Exposure note:** `/healthz` and `/metrics` are unauthenticated and sit *before*
> the rate limiter (standard for orchestration/Prometheus; the metrics are
> non-sensitive aggregate counters with no per-space/principal data). Keep the API
> port internal — the bundled compose binds it to loopback. In a multi-tenant /
> Postgres deployment, bind `/metrics` to an internal interface or gate it at the
> reverse proxy, since it shares the API port.

### Backup / restore

`npm run backup -- <dest.db>` takes a consistent **online** SQLite snapshot (WAL-aware,
safe against a live brain); `npm run restore -- <src.db>` writes one back (stop the
brain first). Both use SQLite's backup API, not a raw file copy.

### Key environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `CEPH_DB` | `./brain.db` | SQLite path |
| `CEPH_PORT` / `CEPH_HTTP_PORT` | `7700` / `7701` | WS / HTTP ports |
| `CEPH_RATE_RPM` / `CEPH_WS_RATE_RPM` | `600` / `1200` | HTTP / WS rate limits |
| `CEPH_MAX_DOCS` | `5000` | resident in-memory doc cap |
| `CEPH_BLOB_BUDGET` | `1 GiB` | per-space blob storage cap (0 = unlimited) |
| `CEPH_EMBED_URL` / `_MODEL` / `_DIM` / `_KEY` | — | route semantic search to a real model |
| `CEPH_LOG` | on | structured request logging (`0` to silence) |

---

## 11. End-to-end: a write

1. A client sends `POST /v1/spaces/kb/notes` (or a WS `update` delta, or an MCP
   `create_note`).
2. HTTP: authenticate → rate-limit → ACL (`role` ∩ capabilities) → secret-scan →
   quota → facet checks.
3. The hub takes the **per-doc lock**, applies the edit to the authoritative Y.Doc,
   runs agent/capability gates (rolling back on violation).
4. On commit: append the delta to the **log** (with actor+ts), **reindex** (nodes,
   edges, FTS, embedding — embedder failures are tolerated), snapshot if due.
5. Fan out the delta to subscribed connections, and (if configured) **publish** it to
   peer instances via the `Broadcaster`.
6. `/metrics` counters and the structured log record the response.

Reads (search, neighbors, get) hit the durable derived index and run lock-free.
