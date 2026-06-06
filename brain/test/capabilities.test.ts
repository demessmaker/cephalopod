// N3: capability-scoped tokens (05 §2.2). Capabilities intersect with the role —
// read-only, write-tag scope, path scope. Read-only is enforced on HTTP and WS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import * as Y from "yjs";
import { WebSocket, WebSocketServer } from "ws";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../src/hub.js";
import { Auth, can } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { wsConn } from "../src/ws.js";
import { handle } from "../src/core/note.js";
import { b64, type ClientMsg, type ServerMsg } from "../src/core/protocol.js";

let httpServer: Server, wss: WebSocketServer, store: SqliteStore;
let httpPort: number, wsPort: number, adminToken: string;
let auth: Auth;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = auth.bootstrapAdmin()!.token;
  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  httpPort = (httpServer.address() as any).port;

  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock, req) => {
    const tok = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? undefined;
    const p = auth.authenticate(tok);
    const caps = auth.capabilities(tok);
    const cAuth: ConnAuth = p
      ? {
          canRead: (s) => can(auth.roleOf(s, p.id), "read"),
          canWrite: (s) => can(auth.roleOf(s, p.id), "write") && caps.mode !== "read",
          kind: p.kind,
        }
      : { canRead: () => false, canWrite: () => false };
    const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), cAuth);
    sock.on("close", () => hub.removeConnection(conn));
  });
  wsPort = (wss.address() as any).port;

  await http("POST", "/spaces", adminToken, { name: "kb" });
  await http("PUT", "/spaces/kb/settings", adminToken, { agentMode: "open" }); // isolate capability behavior from draft-gating
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

// mint a principal (member of kb) with the given capabilities; returns its token
async function mint(name: string, kind: "user" | "agent", role: string, capabilities: object) {
  const p = (await http("POST", "/principals", adminToken, { kind, name, capabilities })).body;
  await http("POST", "/spaces/kb/members", adminToken, { principalId: p.principal.id, role });
  return p.token;
}

function wsCreate(token: string, note: string, title: string) {
  return new Promise<void>((resolve, reject) => {
    const doc = new Y.Doc();
    handle(note, doc).meta.set("title", title);
    const update = Y.encodeStateAsUpdate(doc);
    const ws = new WebSocket(`ws://localhost:${wsPort}?token=${token}`);
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "open", note, space: "kb" }));
      ws.send(JSON.stringify({ t: "update", note, space: "kb", update: b64.enc(update) }));
      setTimeout(() => { ws.close(); resolve(); }, 200);
    });
  });
}

describe("N3 — capability-scoped tokens", () => {
  it("read-only token can read but not write (HTTP)", async () => {
    const ro = await mint("reader", "agent", "editor", { mode: "read" });
    expect((await http("GET", "/spaces/kb/tags", ro)).status).toBe(200);
    expect((await http("POST", "/spaces/kb/notes", ro, { title: "nope" })).status).toBe(403);
  });

  it("read-only token cannot write over WebSocket either", async () => {
    const ro = await mint("reader2", "agent", "editor", { mode: "read" });
    await wsCreate(ro, "n_ro_ws", "Should Not Exist");
    // the content write is denied (the title delta never applies)
    const snap = await http("GET", "/spaces/kb/notes/n_ro_ws", adminToken);
    expect(snap.body.title).not.toBe("Should Not Exist");
  });

  it("write-tag-scoped token may only write notes carrying an allowed tag", async () => {
    const t = await mint("decider", "agent", "editor", { writeTags: ["decision"] });
    expect((await http("POST", "/spaces/kb/notes", t, { title: "Random" })).status).toBe(403);
    const ok = await http("POST", "/spaces/kb/notes", t, { title: "ADR-1", tags: ["decision"] });
    expect(ok.status).toBe(201);
    // and it can't repurpose an out-of-scope note
    const other = (await http("POST", "/spaces/kb/notes", adminToken, { title: "Plain", tags: ["misc"] })).body.id;
    expect((await http("PATCH", `/spaces/kb/notes/${other}`, t, { body: "hijack" })).status).toBe(403);
  });

  it("path-scoped token may only write within its prefix", async () => {
    const t = await mint("biller", "user", "editor", { pathPrefix: "billing/" });
    expect((await http("POST", "/spaces/kb/notes", t, { title: "In", props: { path: "billing/x" } })).status).toBe(201);
    expect((await http("POST", "/spaces/kb/notes", t, { title: "Out", props: { path: "infra/y" } })).status).toBe(403);
  });

  it("capabilities only narrow: full token (no caps) still works", async () => {
    const full = await mint("full", "user", "editor", {});
    expect((await http("POST", "/spaces/kb/notes", full, { title: "Anything" })).status).toBe(201);
  });

  it("capability-scoped tokens cannot mint principals or tokens (no self-escalation)", async () => {
    const ro = await mint("ro-minter", "user", "editor", { mode: "read" });
    expect((await http("POST", "/principals", ro, { kind: "user", name: "x" })).status).toBe(403);
    expect((await http("POST", "/tokens", ro, { principalId: "u_anything" })).status).toBe(403);

    const scoped = await mint("scoped-minter", "user", "editor", { writeTags: ["decision"] });
    expect((await http("POST", "/principals", scoped, { kind: "agent", name: "y" })).status).toBe(403);

    // an unconstrained token still may mint
    const full = await mint("full-minter", "user", "editor", {});
    expect((await http("POST", "/principals", full, { kind: "user", name: "z" })).status).toBe(201);
  });
});
