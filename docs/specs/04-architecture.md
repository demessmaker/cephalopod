# Cephalopod — Architecture

How the brain and arms are built and deployed. Star topology: many arms, one
logical brain per deployment (which may itself be horizontally scaled).

## 1. Component map

```
                         ┌──────────────────────────────────────┐
                         │              THE BRAIN               │
   Arms (clients)        │                                      │
 ┌───────────────┐  ws   │  ┌────────────┐    ┌──────────────┐  │
 │ dev daemon    │◄─────►│  │ Sync Relay │◄──►│ Update Log    │  │  append-only
 │ (replica+CLI) │       │  │ (CRDT fan- │    │ (Postgres /   │  │  per space
 └───────────────┘       │  │  out, ACL) │    │  object store)│  │
 ┌───────────────┐  ws   │  └─────┬──────┘    └──────┬───────┘  │
 │ MCP server    │◄─────►│        │                  │          │
 │ (agent-facing)│  http │  ┌─────▼──────┐    ┌──────▼───────┐  │
 └───────────────┘◄─────►│  │ Query/Cmd  │    │ Snapshots     │  │
 ┌───────────────┐  http │  │ API (HTTP) │    │ (materialized │  │
 │ thin scripts  │◄─────►│  └─────┬──────┘    │  Y.Docs)      │  │
 └───────────────┘       │        │           └───────────────┘  │
                         │  ┌─────▼─────────────────────────┐    │
                         │  │ Indexers: FTS + vector + graph│    │
                         │  └───────────────────────────────┘    │
                         │  ┌───────────────────────────────┐    │
                         │  │ Auth / ACL / Identity         │    │
                         │  └───────────────────────────────┘    │
                         └──────────────────────────────────────┘
```

## 2. The brain (server) components

### 2.1 Sync Relay
- Terminates WebSocket connections; speaks the CRDT sync protocol
  (`02-crdt-sync.md §3.2`).
- Holds hot `Y.Doc` replicas in memory for active documents; applies incoming
  deltas, persists them to the update log, fans out to subscribers.
- Enforces ACL on `SUBSCRIBE` (scope) and on every `UPDATE` (write perms) before
  apply/fan-out.
- Manages scope subscriptions and streams documents in/out of an arm's working
  set as the graph changes.

### 2.2 Query/Command API
- Stateless HTTP service implementing `03-api-mcp.md §2`.
- Reads from indexes/snapshots; writes by generating a CRDT delta and handing it
  to the Sync Relay (single write path → humans, agents, and HTTP converge).

### 2.3 Persistence
- **Update log**: authoritative append-only stream of deltas per space. Backing
  store: Postgres for metadata + log rows; large/old segments offloaded to object
  storage (S3-compatible). Provides audit + time-travel.
- **Snapshots**: periodic compacted document state so new arms / cold docs load
  fast without full replay. Stored as binary blobs keyed by `(doc, version)`.

### 2.4 Indexers (derived, rebuildable)
- Run as internal arms: subscribe to changes, recompute artifacts.
- **Full-text**: Tantivy or Meilisearch (self-hostable, fast) — or Postgres FTS
  for a minimal deployment.
- **Vector**: pgvector (simplest, co-located with Postgres) or a dedicated store
  (Qdrant) at scale. Embeddings via a pluggable model endpoint.
- **Graph**: maintains the queryable adjacency (nodes + edges + reverse edges for
  backlinks) for `neighbors`/traversal/scope-resolution. **Required from v1** —
  it is the only place the whole-space graph is queryable, since arms no longer
  sync a monolithic index doc (`02 §2.2`). Built in Postgres for v1; a dedicated
  graph store (see §4) is a later scale option (OQ-4).

### 2.5 Auth / Identity
- Issues and validates tokens (users + agents), resolves them to identities used
  for ACL and attribution. Detailed in `05-security.md`.

## 3. The arms (clients)

A shared client library, `@cephalopod/client`, provides the replica + local query
engine. Concrete arms:

| Arm | Runtime | Persistence | Role |
|-----|---------|-------------|------|
| Dev daemon / CLI | Node or Rust | SQLite / LevelDB | developer's local replica + CLI |
| MCP server | Node | optional in-mem/SQLite | agent-facing surface |
| Indexer | Node | none (streams) | builds FTS/vector indexes |
| Web/editor (future) | Browser | IndexedDB | human UI (out of v1 scope) |

All arms:
- Hold CRDT docs for their working set, persist locally, sync via the relay.
- Answer reads/traversals locally when the data is cached; fall back to HTTP.

## 4. Storage decision: do we need a graph database?

The original idea framed this as a "remote graph database." Important nuance:

- The **source of truth is the per-note CRDT docs + update log**, not a graph DB.
  The graph DB/index is a *derived, rebuildable* read-model for fast traversal.
- **v1 sizing**: target ~250k notes/space and ~1M+ edges, across ~1–10 spaces per
  self-hosted brain (<100 users). A relational adjacency in Postgres (a `nodes`
  table + an `edges` table with a reverse index, proper indexes on
  `from`/`to`/`type`/`tags`) comfortably serves `neighbors`/`query_graph` and
  bounded N-hop traversal at this scale — recursive CTEs handle few-hop closures
  fine for 1M-edge graphs.
- **Where it strains**: deep/unbounded traversals or much larger graphs. Then
  swap the traversal read-model for a dedicated graph engine (Neo4j / Memgraph /
  Postgres + `pgRouting`/`pg_graphblas`) without touching the source of truth.
  This is OQ-4 — deferred, not needed at the v1 target.

So: CRDT log = truth; search/vector/graph stores = swappable read models. This is
a CQRS-flavored split and is what makes the freeform-but-queryable goal tractable.

## 5. Tech stack (recommended v1)

| Concern | Choice | Why |
|---------|--------|-----|
| CRDT | Yjs | rich-text maturity, ecosystem (`02-crdt-sync.md §1`) |
| Sync transport | WebSocket (`y-websocket`-style protocol) | proven, multiplexable |
| Server runtime | Node/TypeScript | shares Yjs + client types end-to-end |
| Log + metadata | Postgres (+ object storage for cold log/snapshots) | boring, durable, transactional ACL |
| Full-text | Meilisearch (or PG FTS for minimal) | fast, self-host |
| Vector | pgvector → Qdrant at scale | start co-located, grow out |
| MCP | TS MCP SDK | first-class agent surface |
| Client lib | TS (`@cephalopod/client`), Rust port later for native daemon | type-sharing now, perf later |

Rust is attractive for the native dev daemon (single static binary, low memory);
v1 ships the TS client everywhere and ports the daemon to Rust later (OQ-5).

## 6. Deployment

**v1 decision: self-host-first** (resolves OQ-8). v1 ships only the single-tenant
path; the multi-tenant pieces below are designed-for but not built until later.

- **Single-tenant self-host** (v1 target for dev teams): one brain instance
  per team/org; Postgres + object store + the services above, shippable via
  Docker Compose / Helm.
- **Multi-tenant SaaS** (later): spaces are the isolation unit; relay and API are
  horizontally scaled; documents sharded across relay nodes by `(space, doc)`
  with sticky routing so a doc's hot replica lives on one relay.
- **Scaling the relay**: documents are partitioned across relay instances; a
  consistent-hash ring maps `(space, docId) → relay`. Cross-relay fan-out for a
  scope spanning shards is handled by an internal pub/sub (NATS/Redis).

## 7. Reliability

- Acknowledged deltas are durable in the log before fan-out (`02 §6`).
- Relay is restartable: rehydrates hot docs from snapshot + log tail.
- Indexers are rebuildable from the log; their loss is non-fatal.
- Backups = log + snapshots; everything else is derived.
