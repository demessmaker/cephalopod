# Cephalopod — Web Graph Explorer (Phase 4, north-star UI)

A **build-less** browser explorer for the knowledge graph: search → see a note and
its neighborhood as a force-directed graph → click any node to expand → watch it
update live. Plain ES modules, no bundler, no framework.

> Specs: `00-overview.md §5` (the human UI north star), `02-crdt-sync.md`,
> `03-api-mcp.md`. This is a *reference client* of the brain's HTTP/WS API.

## Run

```bash
# 1) start the brain (see ../brain) — HTTP on :7701, WS on :7700
# 2) start the explorer (proxies /v1 -> brain; browser talks same-origin)
npm start                 # http://localhost:8080  (env: PORT, BRAIN_URL)
```

Open `http://localhost:8080`, paste a token (from the brain's bootstrap log or a
created principal), enter a space, and search. The WS field (`ws://localhost:7700`)
enables live refresh of the focused note.

```bash
npm test                  # layout engine + static/proxy server (9 tests)
```

## What's here

| File | Role |
|------|------|
| `src/graph.js` | **pure** force-directed layout (deterministic, unit-tested) |
| `src/api.js` | same-origin API client + live-update WebSocket |
| `src/app.js` | the UI: search, results, SVG graph, note panel, click-to-expand |
| `src/index.html`, `src/styles.css` | markup + styles |
| `src/serve.mjs` | dev server: static files + reverse-proxy of `/v1` to the brain |

## Design notes

- **No build step.** The browser loads `app.js` (ES module) directly; `graph.js`
  is shared with the tests as-is. Easy to later wrap in a bundler/framework.
- **Same-origin via proxy.** `serve.mjs` proxies `/v1/*` to the brain so the
  browser avoids CORS; live updates use the brain WS directly.
- **Lazy-neighborhood navigation.** Each focus fetches only `get_note` + 1-hop
  `neighbors` (02 §3.3) — clicking a node re-focuses and expands.
- **Tested core.** The layout math and the static/proxy server are unit-tested;
  the SVG rendering itself is intended to be eyeballed in a browser.
