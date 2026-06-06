// MCP prompts (03 §4.4): guided workflows that make agents better contributors.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CephalopodClient } from "./client.js";

const userMsg = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer, client: CephalopodClient): void {
  // capture-decision — write a well-formed #decision note, linked to related ones.
  server.registerPrompt(
    "capture-decision",
    {
      title: "Capture a decision",
      description: "Guide the agent to record an architecture/design decision as a well-formed #decision note.",
      argsSchema: {
        title: z.string().describe("short decision title"),
        context: z.string().optional().describe("why this decision is needed"),
        decision: z.string().optional().describe("what was decided"),
        alternatives: z.string().optional().describe("options considered"),
      },
    },
    async ({ title, context, decision, alternatives }) => {
      // surface possibly-related existing decisions to link/supersede
      let related: { id: string; title: string }[] = [];
      try {
        related = (await client.search(title, 5, "hybrid")).hits.filter((h) => h.tags.includes("decision"));
      } catch {
        /* offline-ish: proceed without suggestions */
      }
      const relatedBlock = related.length
        ? "Possibly related existing decisions (consider linking with `relates_to` or `supersedes`):\n" +
          related.map((r) => `- [[${r.id}|${r.title}]]`).join("\n")
        : "No closely related decisions found in the graph.";

      return userMsg(
        `Record this as a decision note in the team knowledge graph using the \`create_note\` tool.\n\n` +
          `Title: ${title}\n\n` +
          `Use this body structure (Markdown):\n\n` +
          `## Context\n${context ?? "<why is this decision needed?>"}\n\n` +
          `## Decision\n${decision ?? "<what did we decide?>"}\n\n` +
          `## Alternatives considered\n${alternatives ?? "<what else was on the table, and why not?>"}\n\n` +
          `## Consequences\n<trade-offs and follow-ups>\n\n` +
          `Tag it \`decision\`. Link it to the services/components it affects with \`link_notes\` ` +
          `(type \`affects\`), and to superseded decisions with type \`supersedes\`.\n\n` +
          relatedBlock,
      );
    },
  );

  // onboard — assemble an onboarding subgraph for a given service.
  server.registerPrompt(
    "onboard",
    {
      title: "Onboard onto a service",
      description: "Gather what the graph knows about a service and draft an onboarding summary.",
      argsSchema: { service: z.string().describe("service note id or title") },
    },
    async ({ service }) => {
      const id = await client.resolveRef(service);
      if (!id) {
        return userMsg(
          `No note matches "${service}". Use \`search\` to find the right service, or \`create_note\` to start its page, then re-run onboard.`,
        );
      }
      const note = await client.getNote(id);
      const nb = await client.neighbors(id, 1, "both");
      const neighbors = nb.nodes
        .filter((n) => n.id !== id)
        .map((n) => {
          const edge = nb.edges.find((e) => e.to === n.id || e.from === n.id);
          const rel = edge?.type ? `(${edge.type})` : "";
          return `- [[${n.id}|${n.title}]] ${rel}${n.stub ? " — stub, undocumented" : ""}`;
        });
      return userMsg(
        `You are onboarding a developer onto **${note.title}**. Here's what the knowledge graph knows:\n\n` +
          `### ${note.title}\n${note.body || "(no description yet)"}\n\n` +
          `### Directly connected (1 hop)\n${neighbors.length ? neighbors.join("\n") : "(no links yet)"}\n\n` +
          `Tasks:\n` +
          `1. Read the connected notes (use \`get_note\`) to understand dependencies and ownership.\n` +
          `2. Produce a concise onboarding summary: what it does, key dependencies, where to start.\n` +
          `3. If anything important is missing or any neighbor is a stub, capture it with \`create_note\` ` +
          `(it will land as a #draft for a human to review).`,
      );
    },
  );
}
