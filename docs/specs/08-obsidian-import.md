# Cephalopod — Obsidian Vault Importer

The decided v1 seeding path (`06 §5` Q5): map an existing Obsidian vault into a
space ~1:1 so a team arrives with a populated graph. Obsidian is the closest
existing model — markdown files + `[[wikilinks]]` + tags — so most of the work is
**identity, link resolution, and attachments**, not format translation.

> Builds on: `01-data-model.md` (notes/links/tags/props, title resolution §2.2,
> edge ids §2.3), `02-crdt-sync.md §2.1` (`outLinks`, write path) and `§7`
> (binaries as blobs), `05-security.md §4` (provenance).

## 1. What an Obsidian vault is

A folder tree containing:

- `*.md` files — each is a note; **the filename (without `.md`) is its title and
  its link target**. Folders are organizational only.
- Optional YAML **frontmatter** at the top of a file (`--- ... ---`).
- **Attachments** — images/PDFs/etc., embedded via `![[file.png]]`.
- `.obsidian/` — app config, plugins, graph settings (workspace-local).
- Special files: `*.canvas` (JSON), Excalidraw drawings, Dataview/Templater query
  blocks inside notes.

## 2. Mapping (the core)

| Obsidian construct | → Cephalopod | Notes |
|--------------------|--------------|-------|
| `Foo/Bar.md` file | a **note** | one note per `.md` file |
| filename `Bar` | `title` | also the default link target |
| folder path `Foo/` | `props.path = "Foo"` | the namespace convention (`01`); folders are not nodes |
| frontmatter `tags:` | `tags` | list or space/comma string → string set |
| inline `#tag` in body | `tags` (and kept inline) | `#a/b` hierarchical tags kept verbatim |
| frontmatter `aliases:` | `props.aliases` **+** alias→id resolution map | so `[[alias]]` links resolve |
| other frontmatter keys | `props.<key>` | preserved as-is |
| body markdown | `body` (`Y.Text`) | wikilinks rewritten per §5 |
| `[[Note]]`, `[[Note\|alias]]` | derived **edge** (`origin:wikilink`, `type:null`) | the syntax is already ours |
| `[[Note#Heading]]`, `[[Note#^blk]]` | edge + `props.fragment` on the edge | anchor preserved, not resolved in v1 |
| `[text](other.md)` (internal) | derived edge | normalized to a wikilink (§5) |
| `[text](https://…)` (external) | left as a normal link | optionally `[[code:: url]]` if it points at a repo (off by default) |
| `![[Note]]` (note embed) | edge `type:"embeds"` | transclusion becomes an explicit `embeds` link |
| `![[image.png]]` (file embed) | **attachment** → blob URL (§4) | not stored in CRDT (`02 §7`) |
| unresolved `[[Ghost]]` | **stub** note (`props.stub=true`) | per `01 §2.2`, never dangling |
| `*.canvas`, Excalidraw | skipped (warned) | out of v1 scope (§7) |
| Dataview/Templater blocks | kept as **raw text** | preserved, never executed |
| `%%comment%%` | kept verbatim | Obsidian comment syntax is harmless |

All imported notes/edges get **provenance** `props.authoredBy = "human"` and
`createdBy = <importing user>` (`05 §4`) — import is human-origin, never gated.

## 3. Identity & idempotency (re-import)

Re-running the import must **update, not duplicate**. The challenge: Obsidian has
no stable note id (identity = filename/path, which renames break).

**Strategy (v1): inject a stable id, fall back to path hash.**

1. On first import of a file, mint `id = n_<ULID>` and (if `--write-back` is set,
   default **on**) write `cephalopod_id: n_…` into the file's frontmatter.
2. On re-import, resolve a file's id in priority order:
   `frontmatter.cephalopod_id` → previous import manifest → `n_path:<blake3(vault-relative-path)>`.
3. The importer persists a **manifest** (`.cephalopod/import-manifest.json` in the
   vault, or a server-side record) mapping `path ↔ id ↔ contentHash` so it can
   detect renames (same id, new path → update `props.path`) and skips
   (unchanged `contentHash`).

Without write-back and without a manifest, a rename looks like delete+create
(old note becomes an orphan); this is the documented limitation of path-hash
identity. Write-back avoids it and is the recommended default.

**Update semantics** (existing id, changed content): the importer applies the new
body as a text change through the normal CRDT write path (`02 §2.1`), so Yjs
computes a minimal diff and any concurrent live edits merge — re-import does not
clobber. `--update=skip|merge|overwrite` controls this (default `merge`).

## 4. Attachments

Per `02 §7`, binaries never enter CRDT state.

- For each `![[file.ext]]` (or `![](path)` to a binary), the importer uploads the
  file to the blob store and rewrites the embed to `![alt](blob://<id>)` (or the
  resolved CDN URL), recording `props.attachments[]` on the note.
- `--attachments=upload|link|skip`:
  - `upload` (default): copy bytes to blob store, rewrite to blob URL.
  - `link`: keep a reference to the original path (no copy) — for vaults that
    stay co-located.
  - `skip`: drop the embed, emit a warning.
- Dedupe by content hash so the same image embedded in 50 notes is stored once.

## 5. Link & embed rewriting

A pure transform over body text, run in **pass 2** (after all ids are known):

1. **Resolve** each `[[target]]` to an id using: exact filename match →
   case-insensitive match → alias map → else mint a stub (`01 §2.2`). Record the
   chosen id; flag `ambiguous` if multiple files share the name.
2. **Rewrite to id-form for stability**: `[[Billing]]` → `[[n_abc|Billing]]`.
   This preserves the displayed text while making the link survive future renames
   (the derived edge binds to id, `01 §2.2`). `--keep-titles` disables rewriting
   for teams who prefer human-readable source.
3. **Normalize internal markdown links** `[text](Note.md#h)` → `[[n_id#h|text]]`.
4. **Note embeds** `![[Note]]` → keep as an embed but ensure the `embeds` edge is
   created in `outLinks` (explicit), so transclusion is a first-class edge.
5. **Heading/block anchors** (`#Heading`, `#^block`) are carried as
   `props.fragment` on the resulting edge; not resolved to a sub-location in v1.

Derived (wikilink) edges then fall out of the body exactly as `07 §7` /
`02 §2.2` describe — the importer does not hand-build a separate edge list except
for `embeds` (explicit).

## 6. Algorithm & CLI

### Two-pass import
```
PASS 1 — discover & create
  walk vault for *.md (respecting .gitignore-style excludes)
  for each file: parse frontmatter, compute contentHash, resolve/mint id
  build maps: title→id, alias→id, path→id
  create/upsert note docs (title, tags, props, path, provenance) — empty edges yet

PASS 2 — bodies, links, attachments
  for each file:
    rewrite body (links §5, attachments §4)
    set body via CRDT write path
    create explicit `embeds` edges in outLinks
    (derived wikilink edges are recomputed by the adjacency, 02 §2.2)
  reconcile: any [[target]] with no file → stub note
  write-back cephalopod_id to frontmatter (if enabled); update manifest
```

### CLI
```
cephalopod import obsidian <vault-path> --space <spaceId> [options]

  --update=skip|merge|overwrite   (default merge)
  --attachments=upload|link|skip  (default upload)
  --write-back / --no-write-back  (default write-back)
  --keep-titles                   keep [[Title]] form (no id rewrite)
  --exclude <glob>...             skip paths (e.g. "Templates/**", ".obsidian/**")
  --dry-run                       report only, no writes
  --as <user>                     attribute import to this principal
```

Import runs server-side / via the CLI arm against the bulk write path so a 250k-
note vault doesn't go note-by-note over the live sync protocol.

## 7. Import report

Emitted at the end (and per-file in `--dry-run`):

```
Imported into space sp_eng
  notes:        1,842 created, 37 updated, 1,805 unchanged (skipped)
  edges:        6,210 wikilink, 312 embeds
  stubs:        48 created (unresolved links)
  attachments:  214 uploaded (612 references, deduped)
  warnings:     3 ambiguous links, 2 canvas files skipped
  duration:     12.4s
```

Warnings enumerate: ambiguous link targets (multiple files same name), skipped
unsupported files, dropped attachments, and any frontmatter that failed to parse
(kept as raw text, note still imported).

## 8. Edge cases & non-goals (v1)

- **Canvas / Excalidraw** — skipped with a warning; revisit later (could become a
  note with `props.kind` + an attachment).
- **Dataview / Templater / query blocks** — imported as inert text; Cephalopod
  does not execute Obsidian plugin logic. (A future mapping of Dataview inline
  fields `key:: value` → typed edges/props is noted as OQ-9.)
- **Case-sensitivity & path separators** — normalized to forward-slash, matched
  case-insensitively for link resolution (Obsidian's default).
- **Two notes, same filename in different folders** — both import (ids differ);
  links to the bare name are flagged `ambiguous` and bound per `01 §2.2`.
- **No live sync with Obsidian** — this is a one-way importer, not a bidirectional
  bridge. (A bidirectional Obsidian plugin is a possible future arm, not v1.)

## 9. Open questions

| ID | Question | Default |
|----|----------|---------|
| OQ-9 | Map Dataview inline fields (`key:: value`) to typed edges/props? | No in v1; treat as text. |
| OQ-10 | Blob store backend for attachments. | S3-compatible object store (`04 §2.3`). |
| OQ-11 | Where the import manifest lives (in-vault file vs server record). | Server record keyed by space; optional in-vault copy. |
