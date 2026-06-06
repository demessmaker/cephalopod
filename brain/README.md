# Cephalopod — Brain (Phase 1 / M1–M2)

The persistent sync relay: an append-only update log, materialized snapshots,
multi-space isolation, restart rehydration, a server-derived graph index, plus an
HTTP API, full-text search, and token-based per-space access control.

> Specs: [`../docs/specs/02-crdt-sync.md`](../docs/specs/02-crdt-sync.md) (§2, §4),
> [`04-architecture.md`](../docs/specs/04-architecture.md) (§2, §4),
> [`06-roadmap.md`](../docs/specs/06-roadmap.md) (Phase 1 / M1).

## Status — M1 + M2 done

- ✅ Authoritative per-note Yjs docs, loaded lazily from **snapshot + log tail**.
- ✅ **Append-only update log** (durable) + **periodic snapshots** with log compaction.
- ✅ **Restart rehydration** — verified across a real process restart (write → SIGINT → reboot → read).
- ✅ **Multi-space** isolation.
- ✅ **Server-derived graph index** persisted in the store (no monolithic CRDT
  index doc, `02 §2.2`): neighbors, backlinks, and bounded lazy-neighborhood scopes.
- ✅ **HTTP Query/Command API** (`03 §2`) — notes CRUD, links, traversal, query.
- ✅ **Full-text search** (SQLite FTS5) + tag facets (`03 §3`).
- ✅ **Semantic + hybrid search** (`03 §3`) — per-note embeddings via a pluggable
  `Embedder` (default: dependency-free feature-hashing; a real model is a
  drop-in), vector cosine search, and reciprocal-rank-fusion hybrid ranking.
  `GET /search?mode=text|semantic|hybrid`.
- ✅ **Auth & RBAC** (`05 §1–2`) — principals (users + agents), hashed tokens,
  per-space roles (viewer/editor/admin), enforced on **both HTTP and WS**.
- ✅ **Capability-scoped tokens** (`05 §2.2`) — a token can be `mode:"read"`
  (read-only), `writeTags`-scoped, or `pathPrefix`-scoped; capabilities intersect
  with the role (only narrow). Mint via `POST /principals` / `POST /tokens`.
- ✅ **Rate limits & quotas** (`05 §4–5`) — per-token request rate limit
  (`429 rate_limited`, `CEPH_RATE_RPM`) and per-space note quota
  (`maxNotes` setting → `429 quota_exceeded`).
- ✅ **Secret-scanning + hard-purge** (`05 §5`) — write-time secret detection
  (`secretScan: off|warn|block`; warn → `#secret-suspected`, block → 422) and an
  admin `POST /notes/:id/purge` that expunges all traces (log/snapshots/index/
  search/embeddings) + audit log.
- ✅ **Reversibility** (`05 §4`) — the log records `actor`+`ts`; admin
  `POST /spaces/:s/revert {principalId, since}` undoes a principal's recent edits
  (replay tail without them → attributed overwrite), preserving others'.
- ✅ **Hardening** — unauthenticated `/healthz` (Docker healthcheck), request
  body-size limit (`413 payload_too_large`, `maxBodyBytes`), and WS auth via the
  `Authorization` header / `bearer` subprotocol (with `?token=` fallback) so tokens
  stay out of URLs/logs.
- ✅ **Obsidian vault importer** (`08`) — two-pass, idempotent, in-process bulk
  import: files→notes, `[[wikilinks]]`→edges (id-rewrite + stubs), frontmatter→
  tags/props, `![[embeds]]`→embeds edges, `cephalopod_id` write-back.
- ✅ **Per-space required facets** (`01 §7`) — a space can require `key:value`
  facet tags (e.g. `client`, `project`) on every note (422 if missing), with a
  `#shared`/facet-node exemption; search & listing filter by `?tag=client:acme`.
  Client/project are first-class nodes by convention (`belongs_to`).
- ✅ **Agent draft-gating** (`05 §4`) — writes are provenance-stamped
  (`props.authoredBy`); in a space's default `draft` mode, agent-authored notes
  are forced `#draft` and hidden from search/listing until a human **promotes**
  them. Agents may only edit their own drafts; a space can opt into `open` mode.

## Run

```bash
npm install
npm test                       # 18 tests: persistence/restart/snapshots/scope + HTTP/auth/search + import
npm start                      # WS :7700 + HTTP :7701 (CEPH_DB, CEPH_PORT, CEPH_HTTP_PORT)
npm run import -- <vault> --space eng --db ./brain.db   # import an Obsidian vault
```

### Docker (self-host)

```bash
docker compose up --build            # from the repo root
docker compose logs brain | grep "bootstrap admin token"   # grab the one-time token
```

Exposes WS `:7700` and HTTP `:7701`; data persists in the `cephalopod-data`
volume (CRDT log, snapshots, derived index, auth) — survives container restarts.
*(If you're behind a TLS-intercepting proxy, the build's `npm install` needs your
proxy CA: mount it and set `NODE_EXTRA_CA_CERTS` / `npm config set cafile`.)*

### Bootstrap token

On first run the brain prints a **bootstrap admin token** (shown once). Use it as
`Authorization: Bearer <token>`:

```bash
curl -X POST localhost:7701/v1/spaces -H "Authorization: Bearer $TOK" -d '{"name":"eng"}'
curl -X POST localhost:7701/v1/spaces/eng/notes -H "Authorization: Bearer $TOK" \
  -d '{"title":"Runbook","body":"rollback steps and [[Oncall]]","tags":["runbook"]}'
curl "localhost:7701/v1/spaces/eng/search?q=rollback" -H "Authorization: Bearer $TOK"
```

### HTTP API (all under `/v1`, bearer token required)

| Method | Path | Role | |
|--------|------|------|--|
| POST | `/principals` | any | create a user/agent principal + token |
| GET/POST | `/spaces` | any | list memberships / create a space (creator = admin) |
| POST | `/spaces/:s/members` | admin | grant a role |
| GET/PUT | `/spaces/:s/settings` | read/admin | get/set `agentMode` (`draft`\|`open`) |
| POST/GET/PATCH/DELETE | `/spaces/:s/notes[/:id]` | write/read | note CRUD (agent writes → `#draft`) |
| POST | `/spaces/:s/notes/:id/promote` | write (human) | publish an agent draft |
| POST | `/spaces/:s/links`, `/unlink` | write | edges |
| GET | `/spaces/:s/notes/:id/neighbors`, `/backlinks` | read | traversal |
| GET | `/spaces/:s/search?q=`, `/tags` | read | full-text + facets |
| POST | `/spaces/:s/query` | read | `{match:{text}}` or `{traverse:{from,hops}}` |

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

## Not yet (M3+)

The CLI arm (offline cache), the **MCP server** (agent-facing surface), semantic/
vector search, capability-scoped agent tokens + draft-gating, and the Obsidian
importer — see the roadmap. Note: WS connections without a valid `?token=` are
denied all reads/writes; HTTP without a valid bearer token returns 401.
