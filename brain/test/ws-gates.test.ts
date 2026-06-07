// The WS write path must enforce the SAME hard gates as HTTP — capability
// scope (writeTags/pathPrefix), secret-scanning, and per-space note quota — so an
// agent can't escape its token's scope (or a block policy / quota) by switching
// transports. Soft "warn" secret-tagging is also checked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import * as Y from "yjs";
import { WebSocket, WebSocketServer } from "ws";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../src/hub.js";
import { Auth, can, type Capabilities } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { wsConn } from "../src/ws.js";
import { handle } from "../src/core/note.js";
import { b64, type ClientMsg, type ServerMsg } from "../src/core/protocol.js";

let httpServer: Server;
let wss: WebSocketServer;
let store: SqliteStore;
let httpPort: number;
let wsPort: number;
let adminToken: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = (await auth.bootstrapAdmin())!.token;

  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  httpPort = (httpServer.address() as any).port;

  // WS wiring mirrors src/server.ts: thread capabilities into ConnAuth.
  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", async (sock, req) => {
    const tok = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? undefined;
    const p = await auth.authenticate(tok);
    const caps = await auth.capabilities(tok);
    const cAuth: ConnAuth = p
      ? {
          canRead: async (s) => can(await auth.roleOf(s, p.id), "read"),
          canWrite: async (s) => can(await auth.roleOf(s, p.id), "write") && caps.mode !== "read",
          kind: p.kind,
          principalId: p.id,
          caps,
        }
      : { canRead: () => false, canWrite: () => false };
    const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), cAuth);
    sock.on("close", () => hub.removeConnection(conn));
  });
  wsPort = (wss.address() as any).port;
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

// Mint a fresh space + an editor user holding a token with the given capabilities.
async function setup(space: string, caps: Capabilities = {}, settings?: Record<string, unknown>) {
  const auth = new Auth(store);
  await http("POST", "/spaces", adminToken, { name: space });
  if (settings) await http("PUT", `/spaces/${space}/settings`, adminToken, settings);
  const user = await auth.createPrincipal("user", `u-${space}`);
  await http("POST", `/spaces/${space}/members`, adminToken, { principalId: user.id, role: "editor" });
  return auth.issueToken(user.id, caps);
}

type Fields = { title?: string; body?: string; tags?: string[]; path?: string };

// Write a note purely over the WebSocket; resolves with the first server `error`
// (if any) the brain sends back in response.
function wsWrite(token: string, space: string, note: string, f: Fields) {
  return new Promise<{ error?: { code: string; message: string } }>((resolve, reject) => {
    const doc = new Y.Doc();
    const h = handle(note, doc);
    doc.transact(() => {
      if (f.title) h.meta.set("title", f.title);
      if (f.body) h.body.insert(0, f.body);
      if (f.tags) for (const t of f.tags) h.tags.push([t]);
      if (f.path !== undefined) h.props.set("path", f.path);
    });
    const update = Y.encodeStateAsUpdate(doc);
    const ws = new WebSocket(`ws://localhost:${wsPort}?token=${token}`);
    let error: { code: string; message: string } | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ws.close();
      resolve({ error });
    };
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "error") {
        error = { code: msg.code, message: msg.message };
        finish(); // a denial is the terminal signal — resolve immediately (no flaky wait)
      }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "open", space, note }));
      ws.send(JSON.stringify({ t: "update", space, note, update: b64.enc(update) }));
      setTimeout(finish, 400); // success window (no error expected)
    });
  });
}

describe("WS write gates — parity with the HTTP path", () => {
  it("capability writeTags scope is enforced over WS", async () => {
    const token = await setup("cap-tags", { writeTags: ["allowed"] });

    const denied = await wsWrite(token, "cap-tags", "n_off", { title: "off scope", body: "x", tags: ["other"] });
    expect(denied.error?.code).toBe("scope_denied");
    // rejected write never persisted (note doesn't exist)
    expect((await http("GET", "/spaces/cap-tags/notes/n_off", adminToken)).status).toBe(404);

    const ok = await wsWrite(token, "cap-tags", "n_on", { title: "in scope", body: "x", tags: ["allowed"] });
    expect(ok.error).toBeUndefined();
    expect((await http("GET", "/spaces/cap-tags/notes/n_on", adminToken)).body.tags).toContain("allowed");
  });

  it("capability pathPrefix scope is enforced over WS", async () => {
    const token = await setup("cap-path", { pathPrefix: "billing/" });

    const denied = await wsWrite(token, "cap-path", "n_ops", { title: "ops", body: "x", path: "ops/x" });
    expect(denied.error?.code).toBe("scope_denied");
    expect((await http("GET", "/spaces/cap-path/notes/n_ops", adminToken)).status).toBe(404);

    const ok = await wsWrite(token, "cap-path", "n_bill", { title: "bill", body: "x", path: "billing/x" });
    expect(ok.error).toBeUndefined();
    expect((await http("GET", "/spaces/cap-path/notes/n_bill", adminToken)).status).toBe(200);
  });

  it("secret-scan block rejects WS writes carrying a secret", async () => {
    const token = await setup("sec-block", {}, { secretScan: "block" });

    const denied = await wsWrite(token, "sec-block", "n_leak", {
      title: "leak",
      body: "key AKIAIOSFODNN7EXAMPLE here",
    });
    expect(denied.error?.code).toBe("secret_suspected");
    expect((await http("GET", "/spaces/sec-block/notes/n_leak", adminToken)).status).toBe(404);

    const ok = await wsWrite(token, "sec-block", "n_clean", { title: "clean", body: "nothing secret here" });
    expect(ok.error).toBeUndefined();
    expect((await http("GET", "/spaces/sec-block/notes/n_clean", adminToken)).status).toBe(200);
  });

  it("secret-scan warn tags the note but lets it through over WS", async () => {
    const token = await setup("sec-warn", {}, { secretScan: "warn" });

    const res = await wsWrite(token, "sec-warn", "n_warn", { title: "warn", body: "key AKIAIOSFODNN7EXAMPLE here" });
    expect(res.error).toBeUndefined();
    const snap = await http("GET", "/spaces/sec-warn/notes/n_warn", adminToken);
    expect(snap.status).toBe(200);
    expect(snap.body.tags).toContain("secret-suspected");
  });

  it("per-space note quota is enforced over WS", async () => {
    const token = await setup("quota", {}, { maxNotes: 1 });

    const first = await wsWrite(token, "quota", "n_one", { title: "one", body: "x" });
    expect(first.error).toBeUndefined();
    expect((await http("GET", "/spaces/quota/notes/n_one", adminToken)).status).toBe(200);

    const second = await wsWrite(token, "quota", "n_two", { title: "two", body: "x" });
    expect(second.error?.code).toBe("quota_exceeded");
    expect((await http("GET", "/spaces/quota/notes/n_two", adminToken)).status).toBe(404);
  });

  it("an existing note is left intact when a later edit is rejected (rollback)", async () => {
    const token = await setup("rollback", {}, { secretScan: "block" });
    // a clean note exists and is committed
    await wsWrite(token, "rollback", "n_doc", { title: "doc", body: "original safe content" });
    expect((await http("GET", "/spaces/rollback/notes/n_doc", adminToken)).body.body).toBe("original safe content");

    // a follow-up edit that introduces a secret must be rejected AND rolled back,
    // leaving the previously-committed content untouched.
    const denied = await wsWrite(token, "rollback", "n_doc", { body: "now leaking AKIAIOSFODNN7EXAMPLE here" });
    expect(denied.error?.code).toBe("secret_suspected");
    const snap = await http("GET", "/spaces/rollback/notes/n_doc", adminToken);
    expect(snap.body.body).toBe("original safe content"); // edit rolled back, secret never persisted
  });
});
