# Cephalopod — API & MCP Surface

The API is the product. There are three layers, all over the same core:

1. **Sync API (WebSocket)** — CRDT delta streaming for replicas (`02-crdt-sync.md`).
2. **Query/Command API (HTTP)** — request/response for clients that don't hold a
   replica (dashboards, scripts, the MCP server).
3. **MCP server** — the agent-facing surface; the chosen primary interface.

A client that holds a local replica answers most reads *locally* against its
cached CRDT state; the HTTP API exists for thin clients and agents.

## 1. Sync API (WebSocket)

`wss://brain/space/{spaceId}/sync`

Carries the framed messages of `02-crdt-sync.md §3.2` (`SUBSCRIBE`,
`SYNC_STEP1/2`, `UPDATE`) plus the awareness channel. Auth via bearer token on
the upgrade request; every frame is checked against space ACLs before apply/fan-out.

This is the only path that moves CRDT bytes. Everything below is derived.

## 2. Query/Command API (HTTP/JSON)

Base: `https://brain/v1/spaces/{spaceId}`. Auth: `Authorization: Bearer <token>`.

### 2.1 Notes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/notes` | Create a note (id may be client-supplied for offline). |
| `GET` | `/notes/{id}` | Read note (markdown + metadata). |
| `PATCH` | `/notes/{id}` | Patch title/tags/props/body. Applied as a CRDT delta server-side. |
| `DELETE` | `/notes/{id}` | Tombstone. |
| `GET` | `/notes/{id}/history` | Update log / snapshots for time-travel & blame. |

`PATCH` body edits accept either a full markdown replacement or a structured
text op; the server translates to a CRDT update so HTTP writers and replica
writers converge identically.

### 2.2 Links & traversal

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/links` | Create explicit edge `{from,to,type?,props?}`. |
| `DELETE` | `/links/{id}` | Remove edge. |
| `GET` | `/notes/{id}/links?dir=out\|in\|both&type=` | Adjacent edges (backlinks free). |
| `GET` | `/notes/{id}/neighbors?hops=N&type=&dir=` | N-hop neighborhood (the graph traversal primitive). |

### 2.3 Query

`POST /query` — a single structured query endpoint over tags, properties, links,
and full-text:

```jsonc
{
  "match": {                       // freeform predicate, all optional
    "tags": ["service", "tier:1"], // AND semantics; supports key:value
    "props": { "status": "active" },
    "text": "idempotent charges",  // full-text
    "semantic": "how do we avoid double-charging", // vector search
    "linkedTo": "n_gateway",       // has any edge to this note
    "linkType": "depends_on"
  },
  "traverse": { "from": "n_billing", "hops": 2, "type": "depends_on" },
  "limit": 50,
  "return": ["id", "title", "tags", "snippet"]
}
```

`text` and `semantic` may be combined (hybrid search) — important for agents.

### 2.4 Spaces, tags, search index

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/spaces` | List spaces the caller can access. |
| `GET` | `/tags` | Tag vocabulary + counts (autocomplete). |
| `GET` | `/graph?scope=...` | Export the index subgraph for a scope (nodes+edges). |

## 3. Search & semantic index

- **Full-text**: per-space inverted index over title+body (Tantivy/Meilisearch/PG
  FTS — see `04-architecture.md`). Rebuildable from the CRDT log.
- **Semantic/vector**: per-note embedding (`01-data-model.md §4`) in a vector
  index; powers `match.semantic`. Embeddings recomputed on note change by an
  indexer arm.
- **Hybrid ranking**: reciprocal-rank fusion of full-text + vector, optionally
  re-ranked by graph proximity to a focus node.

## 4. MCP server (primary agent interface)

`cephalopod-mcp` is an MCP server wrapping the HTTP API (and optionally holding a
replica for low-latency reads). It exposes **tools**, **resources**, and
**subscriptions**.

### 4.1 Tools

| Tool | Args | Returns |
|------|------|---------|
| `search` | `query`, `tags?`, `semantic?`, `limit?` | ranked notes (id, title, snippet) |
| `get_note` | `id` | full markdown + metadata + links |
| `create_note` | `title`, `body`, `tags?`, `props?` | new note id |
| `update_note` | `id`, `body?`, `tags?`, `props?` | ok / new state |
| `link_notes` | `from`, `to`, `type?` | edge id |
| `unlink_notes` | `from`, `to`, `type?` | ok |
| `neighbors` | `id`, `hops?`, `type?`, `dir?` | subgraph (nodes+edges) |
| `query_graph` | structured query (§2.3) | matching subgraph |
| `list_spaces` | — | spaces caller can access |

Design notes for agent ergonomics:

- Tools accept **titles or ids** where a note is referenced; title→id resolution
  uses §01-2.2 and returns the chosen id so the agent can be precise next time.
- `create_note`/`update_note` go through the same CRDT write path as humans, so
  an agent and a developer editing the same note converge — and the agent's
  presence shows in awareness ("🤖 indexing-agent is editing").
- Writes are attributed to the agent's identity (`05-security.md`) for blame/audit.

### 4.2 Resources

Notes are exposed as MCP **resources** so agents can pull them into context
without a tool round-trip:

```
cephalopod://{spaceId}/note/{id}          → markdown + frontmatter
cephalopod://{spaceId}/graph?scope=...    → serialized subgraph
```

Resource `list` is backed by `query`/`search`; resource `read` by `get_note`.

### 4.3 Subscriptions (live knowledge for agents)

Because the substrate is real-time, the MCP server supports **resource update
notifications**: an agent subscribes to a note or a scope and is notified when it
changes (e.g. a long-running agent watching the runbook subgraph). Backed by the
WebSocket sync stream; surfaced as MCP `notifications/resources/updated`.

### 4.4 Prompts

Optional MCP **prompts** ship common workflows, e.g.:

- `capture-decision` — guides the agent to write a well-formed `#decision` note
  with `supersedes`/`relates_to` links.
- `onboard` — assembles an onboarding subgraph for a given service.

## 5. Idempotency, errors, limits

- All mutating HTTP/MCP calls accept an `Idempotency-Key`; combined with
  deterministic ids (`01-data-model.md §2.3`) retries are safe.
- Errors are typed: `auth`, `not_found`, `scope_denied`, `rate_limited`,
  `stub_created` (informational), `ambiguous_title` (needs disambiguation).
- Per-token rate limits and per-space quotas; agent tokens can be scoped to
  read-only or specific tag namespaces (`05-security.md`).

## 6. SDKs (planned)

- `@cephalopod/client` (TS) — holds a replica, exposes the same query surface
  locally; used by the MCP server, CLI, and the future web/editor clients.
- Thin REST bindings auto-generated from an OpenAPI doc for other languages.
