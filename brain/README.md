# Cephalopod — Brain (Phase 1 / M1)

The persistent sync relay: an append-only update log, materialized snapshots,
multi-space isolation, restart rehydration, and a server-derived graph index —
graduated from the M0 spike into real code.

> Specs: [`../docs/specs/02-crdt-sync.md`](../docs/specs/02-crdt-sync.md) (§2, §4),
> [`04-architecture.md`](../docs/specs/04-architecture.md) (§2, §4),
> [`06-roadmap.md`](../docs/specs/06-roadmap.md) (Phase 1 / M1).

## Status — M1 done

- ✅ Authoritative per-note Yjs docs, loaded lazily from **snapshot + log tail**.
- ✅ **Append-only update log** (durable) + **periodic snapshots** with log compaction.
- ✅ **Restart rehydration** — verified across a real process restart (write → SIGINT → reboot → read).
- ✅ **Multi-space** isolation.
- ✅ **Server-derived graph index** persisted in the store (no monolithic CRDT
  index doc, `02 §2.2`): neighbors, backlinks, and bounded lazy-neighborhood scopes.

## Run

```bash
npm install
npm test                       # 6 tests: persistence + restart + snapshots + scope
npm start                      # ws://localhost:7700 (CEPH_DB=./brain.db CEPH_PORT=7700)
```

## Architecture

```
ws client ─┐
ws client ─┼─►  ws-server  ─►  SpaceHub  ─►  Store (SQLite)
ws client ─┘                     │             ├─ updates  (append-only log)
                                 │             ├─ snapshots(materialized Y.Doc state)
                                 │             ├─ nodes    (derived index)
                                 │             └─ edges    (derived index + reverse)
                                 └─ in-memory Y.Docs (loaded on demand) + fan-out
```

- `src/core/` — note schema, ids, wikilink derivation, wire protocol (graduated
  from M0; `title` is an LWW `meta` field per the M0 finding).
- `src/store/` — `Store` interface + `SqliteStore`. **SQLite is the durable
  default for self-host-first v1** (`04 §6`); a Postgres implementation of the
  same interface is the multi-tenant target — nothing above the store knows which
  backend is in use.
- `src/hub.ts` — `SpaceHub`: lazy doc load, apply→log→reindex→snapshot→fan-out,
  scope resolution over the persisted index.
- `src/server.ts` — the long-running brain; snapshots all docs on graceful shutdown.

## What M1 deliberately does NOT include yet

Auth/ACL, the HTTP query/command API, full-text & vector search, the MCP server,
and the Obsidian importer — those are M2+ (see the roadmap). The relay currently
trusts every connection; **do not expose it publicly** until M2 auth lands.
