# Cephalopod — Overview & Vision

> A second brain for development teams: a distributed, freeform knowledge
> graph that humans *and* AI agents read and write in real time.

## 1. The metaphor

A cephalopod (octopus) has a *distributed* nervous system — a central brain plus
semi-autonomous neural clusters in every arm. Each arm can sense and act locally,
while the central brain coordinates the whole animal.

Cephalopod mirrors this topology:

- **Central brain** — the authoritative, persistent knowledge graph and sync relay.
- **Arms** — clients (developer machines, CI jobs, AI agents) that each hold a
  *local replica* of the part of the graph they care about.
- **Tentacle / working set** — the cached subgraph an arm is actively working on.

Arms operate offline and locally, then stream **deltas** to the central brain,
which merges them conflict-free and fans them back out to other arms.

## 2. The problem

Team knowledge is fragmented across wikis, docs, Slack threads, PR descriptions,
and people's heads. It rots, it's unsearchable, and — increasingly — **AI agents
have no good interface to it**. Existing tools optimize for one mode:

- Obsidian/Logseq: great freeform graphs, but single-player / file-sync only.
- Notion/Confluence: collaborative, but document-centric, weakly linked, no
  programmatic/agent-native interface, no offline graph.
- Code-knowledge tools: structured but rigid, and decoupled from prose.

Nothing gives a dev team a **shared, live, freeform graph** that is equally
usable by a human in an editor and an agent over MCP.

## 3. What Cephalopod is

A **freeform knowledge graph** (chosen schema model):

- Nodes are **notes** (markdown). Edges are **links** between notes
  (Obsidian-style `[[wikilinks]]`), optionally typed by convention via tags.
- Structure emerges from how people link and tag — there is no required schema.

A **real-time CRDT** substrate (chosen sync model):

- Every replica converges automatically; concurrent edits never produce a
  hard conflict requiring manual merge.
- Works offline; reconciles on reconnect.

An **API/MCP-first** surface (chosen interface):

- The primary product surface is a programmatic API and an **MCP server**.
- Agents can search, read, write, link, and traverse the graph as tools and
  resources. Human UIs (editor plugin, web explorer) are clients of the same API
  and are explicitly out of scope for v1 (see Non-goals).

## 4. Goals

| # | Goal |
|---|------|
| G1 | A team's knowledge lives in one shared, freeform graph. |
| G2 | Concurrent human + agent edits converge automatically (CRDT). |
| G3 | Each client caches only the subgraph it needs and works offline. |
| G4 | Agents are first-class: full read/write/traverse over MCP. |
| G5 | Deltas are small, frequent, and access-controlled. |
| G6 | Knowledge is attributable, time-traveled, and auditable. |

## 5. Non-goals (v1)

- **No rich human UI in v1.** No web editor or IDE plugin shipped first; the
  graph explorer and editor are reference clients built *after* the API/MCP/CRDT
  core proves out. (They remain north-star, see `06-roadmap.md`.)
- **No imposed/typed schema.** We will not ship entity validation or required
  properties. Typing is convention (tags) only.
- **No peer-to-peer mesh in v1.** Sync is star-topology through the central
  brain (simpler auth, persistence, partitioning). P2P is a later option.
- **Not a code indexer.** Cephalopod links *to* code (URLs/symbols) but does not
  parse or own source code.

## 6. Personas

- **The developer** — caches the subgraph for the feature they're building,
  jots design notes, links them to services/decisions, works on a plane, syncs
  on landing.
- **The agent** — a coding/assistant agent that, mid-task, queries "what do we
  know about the billing service?", reads linked decisions, and writes back a
  new note capturing what it learned. Operates entirely over MCP.
- **The team lead** — wants the institutional memory to survive turnover and to
  see how knowledge connects and who contributed it.

## 7. Spec map

| Doc | Contents |
|-----|----------|
| `00-overview.md` | This document. |
| `01-data-model.md` | Notes, links, tags, properties, identity. |
| `02-crdt-sync.md` | CRDT design, deltas, subgraph caching, offline. |
| `03-api-mcp.md` | HTTP/WebSocket API and the MCP tool/resource surface. |
| `04-architecture.md` | Components, storage, partitioning, deployment. |
| `05-security.md` | Auth, spaces, ACLs, attribution, audit. |
| `06-roadmap.md` | Phasing, milestones, open questions. |

## 8. Glossary

- **Space** — a top-level container (≈ a team or repo) with its own ACL.
  A space owns one logical graph.
- **Note** — a node; a markdown document with tags and properties.
- **Link** — a directed edge between two notes, optionally typed.
- **Working set** — the subgraph a client has cached locally.
- **Delta** — a CRDT update (binary diff) describing a change.
- **Brain** — the central server (relay + persistent store).
- **Arm** — any client holding a replica.
