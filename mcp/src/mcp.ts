// The Cephalopod MCP server: agent-facing tools over the brain API (03 §4.1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CephalopodClient } from "./client.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export function buildServer(client: CephalopodClient): McpServer {
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

  return server;
}
