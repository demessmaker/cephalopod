# Cephalopod for VS Code

Edit your team's Cephalopod knowledge graph without leaving the editor. Each note
opens as an ordinary **markdown buffer** backed by a live CRDT replica: your saves
stream conflict-free deltas to the brain, and a teammate's (or an agent's) edits
flow back into the open buffer in real time — the same sync model as the CLI arm
and the web editor, just wired into VS Code.

## How it works

A note is surfaced through a virtual file system (`cephalopod:/<id>.md`). The
extension is two halves:

- **`src/session.ts` — `EditorSession`** (no `vscode` dependency): an in-memory set
  of per-note `Y.Doc`s that sync over the brain's WebSocket relay using the same
  state-vector handshake as the arm. An editor save hands it the whole buffer; it
  maps that to the **smallest** `Y.Text` edit (`src/diff.ts`, surrogate-pair safe)
  so concurrent collaborators converge instead of clobbering each other. Offline
  edits queue and flush on reconnect.
- **`src/extension.ts` — the editor glue**: a `FileSystemProvider` (notes as
  buffers), an Explorer tree of the open working set, a status-bar
  connection/unsynced indicator, and commands. A remote delta fires
  `onRemoteChange`, which refreshes the affected buffer.

The split is deliberate: the sync engine is pure and **headlessly testable** (see
`test/`, which runs it against a real brain over WS + HTTP). Only the thin glue
needs a running editor host.

## Settings

| Setting | Default | What |
|---------|---------|------|
| `cephalopod.wsUrl` | `ws://localhost:7700` | Brain WebSocket sync relay |
| `cephalopod.httpUrl` | `http://localhost:7701` | Brain HTTP API (search, scope pulls) |
| `cephalopod.space` | — | The space (graph) this window edits |
| `cephalopod.token` | — | API token — prefer **Cephalopod: Set Token** (stored in SecretStorage) |

## Commands

- **Cephalopod: Open Note…** — search the space, pick a hit, open it.
- **Cephalopod: New Note…** — create a note and open it.
- **Cephalopod: Set Note Title…** — title is an LWW field, edited separately from the body.
- **Cephalopod: Pull Scope…** — cache a focus note plus its neighbors into the working set.
- **Cephalopod: Reconnect** — re-establish the relay (also the status-bar action).
- **Cephalopod: Set Token…** — store the API token in SecretStorage.

## Develop / run

```bash
npm install
npm run typecheck      # tsc --noEmit (includes the vscode-API layer)
npm test               # vitest — the session + diff, against a real brain
npm run build          # esbuild -> out/extension.cjs (one bundled CJS file)
```

Then press **F5** in VS Code to launch an Extension Development Host with the
extension loaded, set `cephalopod.space` + a token, and open a note.

> **Scope notes.** The note *body* is the collaborative `Y.Text`; title and tags
> are LWW fields edited via commands (not parsed out of the buffer). The session
> keeps docs in memory for the window's lifetime — the brain is the durable store,
> and the CLI arm covers on-disk offline caching. A live remote delta refreshes a
> buffer only when it isn't dirty, so it won't silently discard unsaved local
> edits. In-editor attachment preview and presence cursors are future work.
