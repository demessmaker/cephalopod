// M4.1 acceptance: MCP resources + live subscriptions. Runs the brain's HTTP and
// WS servers, wires the MCP server with a BrainSocket, and asserts that editing a
// note produces a resources/updated notification to the MCP client.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { SqliteStore } from "../../brain/src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../../brain/src/hub.js";
import { Auth, can } from "../../brain/src/auth.js";
import { createHttpServer } from "../../brain/src/http.js";
import { wsConn } from "../../brain/src/ws.js";
import type { ClientMsg, ServerMsg } from "../../brain/src/core/protocol.js";
import { CephalopodClient } from "../src/client.js";
import { BrainSocket } from "../src/brainsocket.js";
import { buildServer } from "../src/mcp.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let httpServer: Server;
let wss: WebSocketServer;
let store: SqliteStore;
let socket: BrainSocket;
let mcp: Client;
let client: CephalopodClient;
let noteId: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  auth.bootstrapAdmin();
  const agent = auth.createPrincipal("agent", "watcher");
  const token = auth.issueToken(agent.id);
  auth.setRole("eng", agent.id, "editor");
  store.setAgentMode("eng", "open"); // exercise resources/subscriptions, not draft-gating

  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const httpPort = (httpServer.address() as any).port;

  // brain WS relay (same hub) — authenticate via ?token and enforce ACL
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock, req) => {
    const tok = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? undefined;
    const p = auth.authenticate(tok);
    const cAuth: ConnAuth = p
      ? { canRead: (s) => can(auth.roleOf(s, p.id), "read"), canWrite: (s) => can(auth.roleOf(s, p.id), "write") }
      : { canRead: () => false, canWrite: () => false };
    const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), cAuth);
    sock.on("close", () => hub.removeConnection(conn));
  });
  const wsPort = (wss.address() as any).port;

  client = new CephalopodClient(`http://localhost:${httpPort}`, token, "eng");
  noteId = (await client.createNote({ title: "Watched", body: "v1" })).id;

  socket = new BrainSocket(`ws://localhost:${wsPort}`, token);
  await socket.connect();

  const server = buildServer(client, { socket });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
});

afterAll(async () => {
  await mcp.close();
  socket.close();
  wss.close();
  httpServer.close();
  store.close();
});

describe("M4.1 MCP resources + live subscriptions", () => {
  it("lists notes as resources", async () => {
    const { resources } = await mcp.listResources();
    expect(resources.some((r) => r.uri === `cephalopod://eng/note/${noteId}` && r.name === "Watched")).toBe(true);
  });

  it("reads a note resource as markdown", async () => {
    const res = await mcp.readResource({ uri: `cephalopod://eng/note/${noteId}` });
    const c = res.contents[0] as { mimeType?: string; text: string };
    expect(c.mimeType).toBe("text/markdown");
    expect(c.text).toContain("# Watched");
    expect(c.text).toContain("v1");
  });

  it("notifies the agent when a subscribed note changes", async () => {
    const uri = `cephalopod://eng/note/${noteId}`;
    const updated = new Promise<string>((resolve) => {
      mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri));
    });
    await mcp.subscribeResource({ uri });
    await wait(100); // let the WS `open` reach the brain before we edit

    // a different writer changes the note -> brain fans out -> MCP notifies
    await client.updateNote(noteId, { body: "v2 changed" });

    const got = await Promise.race([updated, wait(2000).then(() => "TIMEOUT")]);
    expect(got).toBe(uri);
  });

  it("stops notifying after unsubscribe", async () => {
    const uri = `cephalopod://eng/note/${noteId}`;
    await mcp.unsubscribeResource({ uri });
    await wait(50);

    let fired = false;
    mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, () => { fired = true; });
    await client.updateNote(noteId, { body: "v3 after unsubscribe" });
    await wait(300);
    expect(fired).toBe(false);
  });
});
