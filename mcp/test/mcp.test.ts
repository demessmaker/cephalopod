// M4 acceptance: drive the MCP server in-process against a real brain.
// MCP Client <-(in-memory)-> MCP Server -> HTTP -> SpaceHub -> SQLite.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// brain is a sibling package; import its source directly for the integration test
import { SqliteStore } from "../../brain/src/store/sqlite.js";
import { SpaceHub } from "../../brain/src/hub.js";
import { Auth } from "../../brain/src/auth.js";
import { createHttpServer } from "../../brain/src/http.js";
import { CephalopodClient } from "../src/client.js";
import { buildServer } from "../src/mcp.js";

let httpServer: Server;
let store: SqliteStore;
let mcp: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res: any = await mcp.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data: any = undefined;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!res.isError, data, text };
}

beforeAll(async () => {
  // --- brain ---
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  const admin = (await auth.bootstrapAdmin())!;
  // an agent principal with editor rights in space "eng"
  const agent = await auth.createPrincipal("agent", "indexing-agent");
  const agentToken = await auth.issueToken(agent.id);
  await auth.setRole("eng", agent.id, "editor");
  await auth.setRole("eng", admin.principal.id, "admin");
  store.setAgentMode("eng", "open"); // these tests exercise tools, not draft-gating
  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const port = (httpServer.address() as any).port;

  // --- mcp server wired to the brain via an agent token ---
  const cclient = new CephalopodClient(`http://localhost:${port}`, agentToken, "eng");
  const server = buildServer(cclient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
});

afterAll(async () => {
  await mcp.close();
  httpServer.close();
  store.close();
});

describe("M4 MCP server", () => {
  it("advertises the agent toolset", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["create_note", "get_context", "get_note", "link_notes", "list_spaces", "neighbors", "query_graph", "search", "unlink_notes", "update_note"].sort(),
    );
  });

  it("create_note -> search -> get_note round trip", async () => {
    const created = await call("create_note", {
      title: "Billing Service",
      body: "charges customers; depends on [[Payments Gateway]]",
      tags: ["service"],
    });
    expect(created.data.id).toMatch(/^n_/);

    const found = await call("search", { query: "charges" });
    expect(found.data.some((h: any) => h.title === "Billing Service")).toBe(true);

    // get_note resolves by TITLE (agent ergonomics)
    const got = await call("get_note", { note: "Billing Service" });
    expect(got.data.id).toBe(created.data.id);
    expect(got.data.tags).toContain("service");
  });

  it("derives a wikilink edge and exposes it via neighbors", async () => {
    const r = await call("neighbors", { note: "Billing Service", hops: 1 });
    expect(r.data.edges.some((e: any) => e.origin === "wikilink")).toBe(true);
    expect(r.data.nodes.some((n: any) => n.title === "Payments Gateway" && n.stub)).toBe(true);
  });

  it("link_notes by title + backlinks-style traversal", async () => {
    await call("create_note", { title: "Auth Service" });
    const linked = await call("link_notes", { from: "Auth Service", to: "Billing Service", type: "calls" });
    expect(linked.isError).toBe(false);
    const nb = await call("neighbors", { note: "Billing Service", hops: 1, dir: "in" });
    expect(nb.data.edges.some((e: any) => e.type === "calls")).toBe(true);
  });

  it("get_context bundles a hit + its linked neighbor, with provenance, skipping stubs", async () => {
    const ctx = await call("get_context", { query: "charges", mode: "text", hops: 1 });
    const titles = ctx.data.items.map((i: any) => i.title);
    expect(titles).toContain("Billing Service"); // direct match
    const hit = ctx.data.items.find((i: any) => i.title === "Billing Service");
    expect(hit.relevance).toBe("match");
    expect(hit.provenance).toHaveProperty("authoredBy"); // stamped
    expect(titles).toContain("Auth Service"); // pulled in by 1-hop expansion (calls → Billing)
    expect(ctx.data.items.some((i: any) => i.stub)).toBe(false); // the Payments Gateway stub is not packed
    expect(ctx.data.tokenBudget).toBe(2000); // default budget
    expect(ctx.data.usedTokens).toBeGreaterThan(0);
  });

  it("update_note edits content", async () => {
    const u = await call("update_note", { note: "Auth Service", tags: ["service", "tier:1"] });
    expect(u.data.tags).toContain("tier:1");
  });

  it("reports a clean error for an unknown note", async () => {
    const r = await call("get_note", { note: "Does Not Exist At All" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no note matches/);
  });

  it("mutating tools require an exact match (won't edit a fuzzy-resolved note)", async () => {
    // "Billing Service" exists; a partial/fuzzy title must NOT resolve for a mutation
    const u = await call("update_note", { note: "Billing", tags: ["should-not-apply"] });
    expect(u.isError).toBe(true);
    expect(u.text).toMatch(/exact title/);
    // the real note was left untouched
    const got = await call("get_note", { note: "Billing Service" });
    expect(got.data.tags).not.toContain("should-not-apply");
    // an exact title (or id) still works
    const ok = await call("update_note", { note: "Billing Service", tags: ["service", "ok"] });
    expect(ok.isError).toBe(false);
    expect(ok.data.tags).toContain("ok");
  });

  it("rejects empty required string inputs", async () => {
    const r = await call("create_note", { title: "" });
    expect(r.isError).toBe(true);
  });

  it("list_spaces shows the agent's membership", async () => {
    const r = await call("list_spaces");
    expect(r.data.some((m: any) => m.space === "eng" && m.role === "editor")).toBe(true);
  });

  it("exposes guided prompts", async () => {
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["capture-decision", "onboard"]);
  });

  it("capture-decision returns a structured decision template", async () => {
    const r = await mcp.getPrompt({ name: "capture-decision", arguments: { title: "Adopt Postgres" } });
    const text = (r.messages[0].content as { text: string }).text;
    expect(text).toContain("## Decision");
    expect(text).toContain("create_note");
  });

  it("onboard gathers the service's graph context", async () => {
    await call("create_note", { title: "Search Service", body: "indexes documents" });
    await call("link_notes", { from: "Search Service", to: "Billing Service", type: "calls" });
    const r = await mcp.getPrompt({ name: "onboard", arguments: { service: "Search Service" } });
    const text = (r.messages[0].content as { text: string }).text;
    expect(text).toContain("Search Service");
    expect(text).toContain("Billing Service"); // 1-hop neighbor surfaced
  });
});
