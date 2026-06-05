// The Cephalopod MCP server: agent-facing tools (03 §4.1), resources (§4.2), and
// live subscriptions (§4.3) over the brain API.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CephalopodClient } from "./client.js";
import type { BrainSocket } from "./brainsocket.js";

const noteUri = (space: string, id: string) => `cephalopod://${space}/note/${id}`;
function parseNoteUri(uri: string): { space: string; note: string } {
  const u = new URL(uri);
  return { space: u.hostname, note: u.pathname.split("/").pop() ?? "" };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export function buildServer(client: CephalopodClient, opts: { socket?: BrainSocket } = {}): McpServer {
  const server = new McpServer({ name: "cephalopod", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      description: "Full-text search the team knowledge graph. Returns ranked notes (id, title, tags).",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ query, limit }) => ok((await client.search(query, limit ?? 20)).hits),
  );

  server.registerTool(
    "get_note",
    {
      description: "Read a note's full content + metadata + outgoing links. Accepts a note id or a title.",
      inputSchema: { note: z.string().describe("note id (n_…) or title") },
    },
    async ({ note }) => {
      const id = await client.resolveRef(note);
      if (!id) return fail(`no note matches "${note}"`);
      return ok(await client.getNote(id));
    },
  );

  server.registerTool(
    "create_note",
    {
      description: "Create a new note. Body may contain [[wikilinks]] which become graph edges.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        props: z.record(z.unknown()).optional(),
      },
    },
    async (f) => ok(await client.createNote(f)),
  );

  server.registerTool(
    "update_note",
    {
      description: "Update a note's title/body/tags/props. Accepts a note id or title.",
      inputSchema: {
        note: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        props: z.record(z.unknown()).optional(),
      },
    },
    async ({ note, ...patch }) => {
      const id = await client.resolveRef(note);
      if (!id) return fail(`no note matches "${note}"`);
      return ok(await client.updateNote(id, patch));
    },
  );

  server.registerTool(
    "link_notes",
    {
      description: "Create a directed edge between two notes, optionally typed (e.g. depends_on). Accepts ids or titles.",
      inputSchema: { from: z.string(), to: z.string(), type: z.string().nullable().optional() },
    },
    async ({ from, to, type }) => {
      const [f, t] = await Promise.all([client.resolveRef(from), client.resolveRef(to)]);
      if (!f) return fail(`no source note matches "${from}"`);
      if (!t) return fail(`no target note matches "${to}" — create it first with create_note`);
      await client.link(f, t, type ?? null);
      return ok({ from: f, to: t, type: type ?? null });
    },
  );

  server.registerTool(
    "unlink_notes",
    {
      description: "Remove a directed edge between two notes. Accepts ids or titles.",
      inputSchema: { from: z.string(), to: z.string(), type: z.string().nullable().optional() },
    },
    async ({ from, to, type }) => {
      const [f, t] = await Promise.all([client.resolveRef(from), client.resolveRef(to)]);
      if (!f || !t) return fail("source or target note not found");
      await client.unlink(f, t, type ?? null);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "neighbors",
    {
      description: "Traverse the graph: return the N-hop neighborhood (nodes + edges) around a note.",
      inputSchema: {
        note: z.string(),
        hops: z.number().int().positive().optional(),
        dir: z.enum(["out", "in", "both"]).optional(),
      },
    },
    async ({ note, hops, dir }) => {
      const id = await client.resolveRef(note);
      if (!id) return fail(`no note matches "${note}"`);
      return ok(await client.neighbors(id, hops ?? 1, dir ?? "both"));
    },
  );

  server.registerTool(
    "query_graph",
    {
      description: "Structured query: full-text (text) and/or graph traversal (from + hops).",
      inputSchema: {
        text: z.string().optional(),
        from: z.string().optional(),
        hops: z.number().int().positive().optional(),
        dir: z.enum(["out", "in", "both"]).optional(),
      },
    },
    async ({ text, from, hops, dir }) => {
      if (from) {
        const id = await client.resolveRef(from);
        if (!id) return fail(`no note matches "${from}"`);
        return ok(await client.neighbors(id, hops ?? 1, dir ?? "both"));
      }
      if (text) return ok((await client.search(text)).hits);
      return fail("provide `text` and/or `from`");
    },
  );

  server.registerTool(
    "list_spaces",
    { description: "List the knowledge-graph spaces this agent can access.", inputSchema: {} },
    async () => ok((await client.listSpaces()).spaces),
  );

  // ---- Resources (03 §4.2): notes as cephalopod://{space}/note/{id} ----
  server.registerResource(
    "note",
    new ResourceTemplate("cephalopod://{space}/note/{id}", {
      list: async () => {
        const { notes } = await client.listNotes(100);
        return {
          resources: notes.map((n) => ({
            uri: noteUri(client.space, n.id),
            name: n.title || n.id,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    { title: "Note", description: "A knowledge-graph note as markdown" },
    async (uri, vars) => {
      const note = await client.getNote(String(vars.id));
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# ${note.title}\n\n${note.body}` }],
      };
    },
  );

  // ---- Live subscriptions (03 §4.3): notify when a watched note changes ----
  if (opts.socket) {
    const socket = opts.socket;
    const watched = new Set<string>(); // resource URIs
    server.server.registerCapabilities({ resources: { subscribe: true } });

    server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      const { space, note } = parseNoteUri(req.params.uri);
      socket.open(space, note); // start receiving the brain's fan-out for this note
      watched.add(req.params.uri);
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      watched.delete(req.params.uri);
      return {};
    });

    socket.onUpdate((space, note) => {
      const uri = noteUri(space, note);
      if (watched.has(uri)) void server.server.sendResourceUpdated({ uri });
    });
  }

  return server;
}
