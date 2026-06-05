# Cephalopod — Data Model

The model is **freeform**: a graph of markdown notes connected by links, with
tags and arbitrary properties. There is no required schema; typed structure is a
*convention* expressed through tags, not an enforced constraint.

## 1. Core entities

### 1.1 Note (node)

A note is the unit of knowledge. It is a single markdown document plus metadata.

```jsonc
{
  "id": "n_01HXYZ...",        // stable, opaque, globally unique; never reused
  "space": "sp_billing",      // owning space
  "title": "Billing Service", // human label; mutable; not an identifier
  "body": "...markdown...",   // CRDT-backed rich text (see 02-crdt-sync)
  "tags": ["service", "tier:1", "owner:payments"], // freeform set
  "props": {                  // freeform key→value bag
    "repo": "github.com/acme/billing",
    "status": "active"
  },
  "createdAt": "2026-06-05T...",
  "createdBy": "u_eric",
  "updatedAt": "2026-06-05T...",
  // updatedBy is derived from CRDT attribution, not a single field
}
```

**Identity rules**

- `id` is the only stable identifier. It is assigned at creation (client-side
  generatable: a ULID/UUIDv7 prefixed `n_`) so notes can be created offline.
- `title` is a mutable, non-unique alias. Two notes may share a title; links
  resolve by `id`, not title (see §2.2).
- A note belongs to exactly one `space`. Cross-space references are links by
  fully-qualified id, not membership.

### 1.2 Link (edge)

A directed edge from a source note to a target note.

```jsonc
{
  "id": "e_01HXYZ...",   // derived deterministically (see §2.3) OR explicit
  "from": "n_aaa",
  "to":   "n_bbb",
  "type": "depends_on",  // OPTIONAL convention label; null/"" for plain links
  "origin": "wikilink",  // "wikilink" | "explicit" | "property"
  "props": { }            // optional freeform metadata on the edge
}
```

- Edges are **directed** but always queryable in reverse (backlinks are free).
- `type` is a free string, by convention drawn from a team's tag vocabulary
  (e.g. `depends_on`, `supersedes`, `documents`, `caused_by`). Never validated.
- An edge with no `type` is a plain associative link (vanilla `[[wikilink]]`).

### 1.3 Tag

A tag is just a string applied to a note. Tags are the primary mechanism for
*lightweight* typing and faceting (`#service`, `#decision`, `#runbook`,
`#tier:1`). Conventions:

- `key:value` tags (`owner:payments`) are encouraged for facets and are indexed
  as such, but remain plain strings — no enforced key registry.
- Tags live in a per-space tag index for autocomplete and discovery.

### 1.4 Space

A space is the top-level container and the unit of access control and
partitioning. One space = one logical graph + one ACL (see `05-security.md`).

## 2. Links in depth

### 2.1 Authoring links

Three ways a link comes into existence, all converging on the same edge model:

1. **Wikilink** in body: `[[Billing Service]]` or `[[n_aaa|Billing]]`
   (id-form is unambiguous; title-form resolves per §2.2). → `origin: "wikilink"`.
2. **Typed wikilink**: `[[depends_on:: Payments Gateway]]` — the `type::` prefix
   sets the edge type. → `origin: "wikilink"`, `type: "depends_on"`.
3. **Explicit / property link**: created via API/MCP (`link(from,to,type)`), or
   a note property whose value is a note-ref. → `origin: "explicit"|"property"`.
4. **Code reference** (reserved, v1 = URL only): `[[code:: <url>]]` for a plain
   source link, or `[[symbol:: pkg.Module.func]]` for a symbol. In v1 the target
   is stored as an **external reference** — `props.href` (URL) and/or
   `props.symbol` (string) on the edge — with **no live resolution**. The
   `symbol::` form is reserved now so Phase-3 LSP indexing can later bind it to a
   real definition (file+range at a commit) without a data-model change.
   → `origin: "wikilink"`, `type: "code"`.

Wikilinks are parsed from the CRDT text on every change; the derived edge set is
reconciled into the graph index (see `02-crdt-sync.md §4`).

### 2.2 Title resolution

Title-form wikilinks (`[[Billing Service]]`) resolve to an `id` at link-creation
time within the space:

- If exactly one note has that title → bind to its `id`.
- If none → create a **stub** note (id assigned, empty body) so the link is never
  dangling; stubs are flagged `props.stub = true` and surfaced as "unlinked
  knowledge to be filled in."
- If many → bind to the most recently updated, and flag the link `ambiguous`
  for the author/agent to disambiguate.

The resolved `id` is cached in the link so later renames don't break it.

### 2.3 Edge identity & idempotency

For CRDT convergence, derived edges (wikilinks) use a **deterministic id**:

```
e_id = blake3(from + "→" + to + "::" + type)
```

So the same logical link created concurrently on two replicas produces the same
edge id and merges to one edge (no duplicates). Explicit edges may instead carry
a generated `e_` ULID when intentional multiplicity is desired.

**Where edges are stored.** Explicit edges live in the *source* note's CRDT doc
(`outLinks`, `02 §2.1`) so they sync conflict-free with that note; wikilink edges
are derived from the body and not stored separately. The whole-space queryable
adjacency (incl. backlinks) is a server-derived index, not synced state
(`02 §2.2`).

## 3. Markdown & embedded structure

- Body is **CommonMark + GFM**, with two Cephalopod extensions:
  - `[[wikilinks]]` (and `[[type:: target]]`) as in §2.1.
  - inline `#tags` (optional; tags can also live only in metadata).
- Frontmatter (YAML) is supported on import/export and maps to `props`/`tags`,
  but the canonical store is structured fields, not raw frontmatter text.
- Headings, code blocks, tables, callouts, and embeds (`![[note]]`) are
  preserved through the CRDT rich-text representation.

## 4. Semantic layer (forward-looking, optional)

Because agents are first-class, each note may carry a derived **embedding** for
semantic search. This is an *index artifact*, not part of the source model:

- Computed server-side (or by an indexer arm) from title+body on change.
- Stored alongside the note for vector search (`03-api-mcp.md §3`).
- Never authored or synced as CRDT state.

## 5. History & attribution

- The CRDT update log is the source of truth for *who changed what, when*.
- `updatedBy` is not a single field; the API can return per-field/per-range
  attribution ("blame") derived from CRDT client ids mapped to users.
- Notes are never hard-deleted by default; deletion is a tombstone (CRDT-safe,
  see `02-crdt-sync.md §5`). Hard purge is an admin operation.

## 6. Worked example

```
Note n_billing  title:"Billing Service"  tags:[service, tier:1]
  body: "Charges customers. Depends on [[depends_on:: Payments Gateway]].
         See [[ADR-014: Idempotent Charges]]."

Derived edges:
  e1: n_billing --depends_on--> n_gateway   (origin wikilink, type depends_on)
  e2: n_billing --(plain)----->  n_adr014    (origin wikilink)

Backlink query on n_gateway returns e1 (incoming depends_on from Billing).
```

## 7. Facets & optional structure (per-space)

The global model stays freeform (no imposed schema). Teams that need structure —
e.g. an agency where knowledge maps to a **client** and **project** — opt into it
*per space*, without changing the model for anyone else. This is the concrete form
of the "hybrid" schema choice.

### 7.1 Facets are `key:value` tags

A facet is just a `key:value` tag (`client:acme`, `project:billing-revamp`),
already the model's faceting mechanism (§1.3). They are indexed, surfaced by
`GET /tags`, and filterable on search/listing (`?tag=client:acme`).

### 7.2 Required facets (opt-in, per space)

A space may declare required facet **keys** (e.g. `["client","project"]`). The
brain then rejects (HTTP 422) any note created/retagged without a tag for each
required key. Two exemptions keep cross-cutting knowledge homeless-free:

- a note tagged `shared` (a shared lib, infra runbook, onboarding doc), and
- a note that *is* a facet node (tagged with the key itself, e.g. `#client`).

Set via `PUT /v1/spaces/:s/settings { "requiredFacets": ["client","project"] }`.
Spaces with no requirement behave exactly as before. Bulk import (e.g. Obsidian)
bypasses validation — imports may legitimately be cross-cutting.

### 7.3 Client / project as first-class nodes

Clients and projects are **notes**, not a hardcoded type system: a `#client` note
(`Acme`) and a `#project` note (`Billing Revamp`, tagged `client:acme`), joined by
`belongs_to` edges (note → project → client). Because they are nodes you get
rollups ("everything for Acme" = the client node's neighborhood), a place to hang
context, scoped/graph-proximity search, and a future per-client ACL seam — all via
convention, no schema engine.

```
#client  "Acme"
#project "Billing Revamp"  tags:[project, client:acme]   --belongs_to--> Acme
note     "Idempotent charges"  tags:[decision, client:acme, project:billing-revamp]
           --belongs_to--> "Billing Revamp"
```
