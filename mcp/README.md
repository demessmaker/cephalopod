# Cephalopod — MCP Server (Phase 1 / M4)

The agent-facing surface: a [Model Context Protocol](https://modelcontextprotocol.io)
server that lets AI agents read and write the team knowledge graph as tools. It
wraps the [brain](../brain/)'s HTTP API (`03 §4`) with an agent token, scoped to
one space.

> This is the product thesis in code: agents are first-class readers/writers of
> team memory, converging with human edits through the same CRDT write path.

## Status — M4 (tools) done

- ✅ Nine agent tools (`03 §4.1`), verified end-to-end against a real brain.
- ✅ **Title-or-id ergonomics**: tools accept a note title *or* id and resolve it
  (returning the chosen id), per `03 §4`.
- ✅ Writes go through the brain's HTTP → hub commit path, so agent edits converge
  with live human edits and are attributed to the agent principal.

### Tools

| Tool | Args | Returns |
|------|------|---------|
| `search` | `query`, `limit?` | ranked notes |
| `get_note` | `note` (id/title) | full note + links |
| `create_note` | `title`, `body?`, `tags?`, `props?` | `{ id }` |
| `update_note` | `note`, `title?`/`body?`/`tags?`/`props?` | new state |
| `link_notes` | `from`, `to`, `type?` | resolved edge |
| `unlink_notes` | `from`, `to`, `type?` | ok |
| `neighbors` | `note`, `hops?`, `dir?` | subgraph |
| `query_graph` | `text?`, `from?`, `hops?`, `dir?` | subgraph / hits |
| `list_spaces` | — | memberships |

## Run

```bash
npm install
npm test           # in-process integration: MCP client -> server -> brain -> sqlite
CEPH_URL=http://localhost:7701 CEPH_TOKEN=<agent-token> CEPH_SPACE=eng npm start
```

`npm start` speaks MCP over **stdio** — the transport an agent host (Claude
Code/Desktop) launches. Example client config:

```jsonc
{
  "mcpServers": {
    "cephalopod": {
      "command": "npx",
      "args": ["tsx", "/path/to/cephalopod/mcp/src/server.ts"],
      "env": { "CEPH_URL": "http://localhost:7701", "CEPH_TOKEN": "cph_…", "CEPH_SPACE": "eng" }
    }
  }
}
```

Mint an agent token from the brain: `POST /v1/principals {kind:"agent"}` then grant
it a role with `POST /v1/spaces/:space/members`.

## Not yet (M4.1+)

MCP **resources** (`cephalopod://…/note/{id}`) and **subscriptions** (live
`notifications/resources/updated` backed by the WS stream), MCP **prompts**
(`capture-decision`, `onboard`), and capability-scoped/draft-gated agent tokens
(`05 §4`). See the roadmap.
