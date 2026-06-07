# 🐙 Cephalopod

> A second brain for development teams — a distributed, freeform knowledge graph
> that humans **and** AI agents read and write in real time.

Like an octopus's distributed nervous system (a central brain plus
semi-autonomous neural clusters in every arm), Cephalopod is a **central
knowledge graph** with many **local replicas**. Each developer or agent caches
the subgraph it's working on, edits offline, and streams conflict-free **deltas**
back to the central brain.

## Design pillars

- **Freeform graph** — notes (markdown) linked by `[[wikilinks]]`, organized by
  tags. No imposed schema; structure emerges from how you link.
- **Real-time CRDT** — replicas converge automatically; concurrent human/agent
  edits never hard-conflict, online or offline.
- **API / MCP-first** — the primary surface is programmatic. Agents are
  first-class citizens of team memory via an MCP server.

## Status

🔨 **Building.** Specs in [`docs/specs/`](docs/specs/); code under way:

| Package | Milestone | What |
|---------|-----------|------|
| [`core/`](core/) | — | Shared single-source-of-truth: note schema, ids, wikilink derivation, wire protocol (used by `brain` + `arm`). |
| [`spike/`](spike/) | M0 ✅ | Convergence prototype — validated Yjs + lazy-neighborhood at 250k nodes. |
| [`brain/`](brain/) | M1–M2.5 ✅ | Persistent sync relay (log, snapshots, spaces, restart, derived index) + HTTP API, FTS5 search, token auth & RBAC, and an Obsidian vault importer. |
| [`mcp/`](mcp/) | M4–M4.1 ✅ | MCP server — 9 agent tools, note **resources**, **live subscriptions** (`resources/updated`), and guided **prompts** (`capture-decision`/`onboard`); the agent-facing surface. |
| [`arm/`](arm/) | M3 ✅ | CLI arm — a developer's local replica: offline disk cache, edit-offline→reconnect sync, pull-a-scope, two-arm convergence. |
| [`web/`](web/) | M8 ✅ | Web graph explorer (north-star UI) — build-less: search → force-directed subgraph → click-to-expand → live refresh. |

### Quickstart (self-host)

```bash
docker compose up --build                                   # brain + web explorer
docker compose logs brain | grep "bootstrap admin token"   # one-time admin token
# Explorer :8080 · HTTP API :7701 · WS relay :7700 · metrics :7701/metrics
```

Then create a space, seed from an Obsidian vault (`brain`: `npm run import`), and
point an agent at it via the MCP server (`mcp/README.md`). Agents get live
`resources/updated` notifications as the graph changes. Back up the database with
`brain`: `npm run backup -- <dest.db>` (consistent online snapshot).

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the as-built system reference
(components, data model, sync/scale/security, operations).

### Specs

| Spec | What it covers |
|------|----------------|
| [00 — Overview](docs/specs/00-overview.md) | Vision, metaphor, goals, personas. |
| [01 — Data Model](docs/specs/01-data-model.md) | Notes, links, tags, properties, identity. |
| [02 — CRDT & Sync](docs/specs/02-crdt-sync.md) | CRDT design, deltas, subgraph caching, offline. |
| [03 — API & MCP](docs/specs/03-api-mcp.md) | HTTP/WebSocket API and the MCP surface. |
| [04 — Architecture](docs/specs/04-architecture.md) | Components, storage, scaling, deployment. |
| [05 — Security](docs/specs/05-security.md) | Auth, spaces, ACLs, attribution, agent trust. |
| [06 — Roadmap](docs/specs/06-roadmap.md) | Phasing, milestones, open questions. |
| [07 — Phase-0 Spike](docs/specs/07-phase0-spike.md) | The M0 convergence prototype: what it proves and how to build it. |
| [08 — Obsidian Import](docs/specs/08-obsidian-import.md) | Mapping an Obsidian vault into a space (v1 seeding). |
| [09 — Next Steps](docs/specs/09-next-steps.md) | Post-Phase-1 plan: hardening + the agent-safety track. |

Open questions and questions for the product owner are tracked in
[the roadmap](docs/specs/06-roadmap.md#3-open-questions-tracked).
