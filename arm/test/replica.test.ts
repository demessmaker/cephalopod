// M3 acceptance: a CLI arm caches a scope, edits offline, syncs, and two arms
// converge — against a real brain (HTTP + WS).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { WebSocketServer } from "ws";
import { SqliteStore } from "../../brain/src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../../brain/src/hub.js";
import { Auth, can } from "../../brain/src/auth.js";
import { createHttpServer } from "../../brain/src/http.js";
import { wsConn } from "../../brain/src/ws.js";
import { tokenFromUpgrade } from "../../brain/src/wsauth.js";
import type { ClientMsg, ServerMsg } from "../../brain/src/core/protocol.js";
import { Replica, type ReplicaOptions } from "../src/replica.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let httpServer: Server;
let wss: WebSocketServer;
let store: SqliteStore;
let base: Omit<ReplicaOptions, "cacheDir">;
const tmps: string[] = [];
const cache = () => {
  const d = mkdtempSync(join(tmpdir(), "arm-"));
  tmps.push(d);
  return d;
};

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  auth.bootstrapAdmin();
  const dev = auth.createPrincipal("user", "dev");
  const token = auth.issueToken(dev.id);
  auth.setRole("eng", dev.id, "editor");

  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const httpPort = (httpServer.address() as any).port;

  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock, req) => {
    const tok = tokenFromUpgrade(req); // header (arm) or ?token= fallback
    const p = auth.authenticate(tok);
    const cAuth: ConnAuth = p
      ? { canRead: (s) => can(auth.roleOf(s, p.id), "read"), canWrite: (s) => can(auth.roleOf(s, p.id), "write") }
      : { canRead: () => false, canWrite: () => false };
    const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), cAuth);
    sock.on("close", () => hub.removeConnection(conn));
  });
  const wsPort = (wss.address() as any).port;

  base = { wsUrl: `ws://localhost:${wsPort}`, httpUrl: `http://localhost:${httpPort}`, token, space: "eng" };
});

afterAll(() => {
  wss.close();
  httpServer.close();
  store.close();
  for (const d of tmps.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

describe("M3 CLI arm — local replica + sync", () => {
  it("two arms converge through the brain", async () => {
    const A = new Replica({ ...base, cacheDir: cache() });
    const B = new Replica({ ...base, cacheDir: cache() });
    await A.connect();
    await B.connect();

    const id = A.newNote({ title: "Shared", body: "v1" });
    await A.waitIdle();
    B.openNote(id);
    await B.waitIdle();
    expect(B.getNote(id)?.body).toContain("v1");

    A.appendBody(id, " +fromA");
    await A.waitIdle();
    await B.waitIdle();
    expect(B.getNote(id)?.body).toContain("+fromA");

    A.disconnect();
    B.disconnect();
  });

  it("offline edit persists across a restart and syncs on reconnect", async () => {
    const cacheA = cache();
    // session 1: create + sync, then go offline and edit
    const A1 = new Replica({ ...base, cacheDir: cacheA });
    await A1.connect();
    const id = A1.newNote({ title: "Offline", body: "base" });
    await A1.waitIdle();
    A1.disconnect();
    A1.appendBody(id, " +offline"); // edited while disconnected
    expect(A1.status().dirty).toContain(id);

    // session 2: fresh process on the same cache dir
    const A2 = new Replica({ ...base, cacheDir: cacheA });
    A2.load();
    expect(A2.getNote(id)?.body).toBe("base +offline"); // recovered from disk, offline
    await A2.connect(); // handshake pushes the offline edit
    await A2.waitIdle();
    expect(A2.status().dirty).not.toContain(id);

    // a separate arm sees the offline edit after it synced
    const B = new Replica({ ...base, cacheDir: cache() });
    await B.connect();
    B.openNote(id);
    await B.waitIdle();
    expect(B.getNote(id)?.body).toBe("base +offline");

    A2.disconnect();
    B.disconnect();
  });

  it("an abrupt drop routes later edits to the offline queue (not lost)", async () => {
    const A = new Replica({ ...base, cacheDir: cache() });
    await A.connect();
    const id = A.newNote({ title: "Drop", body: "v1" });
    await A.waitIdle();

    // simulate a network drop — NOT a clean disconnect() — by killing the socket
    (A as any).ws.terminate();
    await wait(50);
    expect(A.connected).toBe(false);

    A.appendBody(id, " +afterdrop");
    expect(A.status().dirty).toContain(id); // queued for the next reconnect, not swallowed
    A.disconnect();
  });

  it("pull caches a scope (focus + neighbors)", async () => {
    const A = new Replica({ ...base, cacheDir: cache() });
    await A.connect();
    const hub = A.newNote({ title: "Hub", body: "x" });
    const leaf = A.newNote({ title: "Leaf", body: "y" });
    A.link(hub, leaf, "depends_on");
    await A.waitIdle();
    A.disconnect();

    const C = new Replica({ ...base, cacheDir: cache() });
    await C.connect();
    const ids = await C.pullScope(hub, 1);
    await C.waitIdle();
    expect(ids).toContain(hub);
    expect(ids).toContain(leaf);
    expect(C.getNote(leaf)?.title).toBe("Leaf"); // content pulled locally
    C.disconnect();
  });
});
