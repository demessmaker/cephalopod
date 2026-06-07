// N2: the WebSocket write path enforces agent policy (draft-gate, facets,
// provenance) just like HTTP — agents can't bypass it by writing over WS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../src/hub.js";
import { Auth, can } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { wsConn } from "../src/ws.js";
import { handle } from "../src/core/note.js";
import { b64, type ClientMsg, type ServerMsg } from "../src/core/protocol.js";

let httpServer: Server;
let wss: import("ws").WebSocketServer;
let store: SqliteStore;
let httpPort: number;
let wsPort: number;
let adminToken: string;
let agentToken: string;
let userToken: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = (await auth.bootstrapAdmin())!.token;
  const agent = await auth.createPrincipal("agent", "bot");
  agentToken = await auth.issueToken(agent.id);
  const user = await auth.createPrincipal("user", "dev");
  userToken = await auth.issueToken(user.id);

  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  httpPort = (httpServer.address() as any).port;

  const { WebSocketServer } = await import("ws");
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", async (sock, req) => {
    const tok = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? undefined;
    const p = await auth.authenticate(tok);
    const cAuth: ConnAuth = p
      ? { canRead: async (s) => can(await auth.roleOf(s, p.id), "read"), canWrite: async (s) => can(await auth.roleOf(s, p.id), "write"), kind: p.kind }
      : { canRead: () => false, canWrite: () => false };
    const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), cAuth);
    sock.on("close", () => hub.removeConnection(conn));
  });
  wsPort = (wss.address() as any).port;

  // space "kb" (draft default) — both can write
  await http("POST", "/spaces", adminToken, { name: "kb" });
  await http("POST", "/spaces/kb/members", adminToken, { principalId: agent.id, role: "editor" });
  await http("POST", "/spaces/kb/members", adminToken, { principalId: user.id, role: "editor" });
  // faceted space "agency" (draft + requires client/project)
  await http("POST", "/spaces", adminToken, { name: "agency" });
  await http("PUT", "/spaces/agency/settings", adminToken, { requiredFacets: ["client", "project"] });
  await http("POST", "/spaces/agency/members", adminToken, { principalId: agent.id, role: "editor" });
});
afterAll(() => {
  wss.close();
  httpServer.close();
  store.close();
});

async function http(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${httpPort}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Create a note purely over the WebSocket (the path that bypassed policy).
function wsWriteNote(token: string, space: string, note: string, f: { title?: string; body?: string; tags?: string[] }) {
  return new Promise<void>((resolve, reject) => {
    const doc = new Y.Doc();
    const h = handle(note, doc);
    doc.transact(() => {
      if (f.title) h.meta.set("title", f.title);
      if (f.body) h.body.insert(0, f.body);
      if (f.tags) for (const t of f.tags) h.tags.push([t]);
    });
    const update = Y.encodeStateAsUpdate(doc);
    const ws = new WebSocket(`ws://localhost:${wsPort}?token=${token}`);
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "open", space, note }));
      ws.send(JSON.stringify({ t: "update", space, note, update: b64.enc(update) }));
      setTimeout(() => { ws.close(); resolve(); }, 250);
    });
  });
}

describe("N2 — WS write path enforces agent policy", () => {
  it("agent WS write is forced to #draft + stamped, even if it tries to be live", async () => {
    await wsWriteNote(agentToken, "kb", "n_ws_agent", { title: "Sneaky", body: "written over websocket", tags: ["service"] });
    const snap = await http("GET", "/spaces/kb/notes/n_ws_agent", adminToken);
    expect(snap.body.tags).toContain("draft"); // could not publish via WS
    expect(snap.body.tags).toContain("service"); // own tag preserved
    expect(snap.body.props.authoredBy).toBe("agent");
    // hidden from discovery by default, visible with drafts=1
    expect((await http("GET", "/spaces/kb/search?q=websocket", adminToken)).body.hits).toHaveLength(0);
    expect((await http("GET", "/spaces/kb/search?q=websocket&drafts=1", adminToken)).body.hits.map((h: any) => h.id)).toContain("n_ws_agent");
  });

  it("human WS write is unaffected (stays live)", async () => {
    await wsWriteNote(userToken, "kb", "n_ws_human", { title: "Human Note", body: "human over websocket" });
    const snap = await http("GET", "/spaces/kb/notes/n_ws_human", adminToken);
    expect(snap.body.tags).not.toContain("draft");
    expect((await http("GET", "/spaces/kb/search?q=human", adminToken)).body.hits.map((h: any) => h.id)).toContain("n_ws_human");
  });

  it("agent WS write missing required facets is quarantined with #needs-facets", async () => {
    await wsWriteNote(agentToken, "agency", "n_ws_nofacet", { title: "No Facets", body: "agent skipped client/project" });
    const a = await http("GET", "/spaces/agency/notes/n_ws_nofacet", adminToken);
    expect(a.body.tags).toContain("draft");
    expect(a.body.tags).toContain("needs-facets");

    await wsWriteNote(agentToken, "agency", "n_ws_facet", { title: "With Facets", body: "ok", tags: ["client:acme", "project:x"] });
    const b = await http("GET", "/spaces/agency/notes/n_ws_facet", adminToken);
    expect(b.body.tags).toContain("draft"); // still gated (draft space)
    expect(b.body.tags).not.toContain("needs-facets"); // facets satisfied
  });
});
