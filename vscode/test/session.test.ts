// EditorSession against a real brain (HTTP + WS), the same harness the CLI arm
// uses. Proves the editor's whole-buffer save path converges, that a remote delta
// fires onRemoteChange (the hook the FileSystemProvider uses to refresh a buffer),
// and that offline edits queue and flush on reconnect.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { SqliteStore } from "../../brain/src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../../brain/src/hub.js";
import { Auth, can } from "../../brain/src/auth.js";
import { createHttpServer } from "../../brain/src/http.js";
import { wsConn } from "../../brain/src/ws.js";
import { tokenFromUpgrade } from "../../brain/src/wsauth.js";
import type { ClientMsg, ServerMsg } from "../../brain/src/core/protocol.js";
import { EditorSession, type SessionOptions } from "../src/session.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let httpServer: Server;
let wss: WebSocketServer;
let store: SqliteStore;
let base: SessionOptions;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  auth.bootstrapAdmin();
  const dev = await auth.createPrincipal("user", "dev");
  const token = await auth.issueToken(dev.id);
  await auth.setRole("eng", dev.id, "editor");

  httpServer = createHttpServer(hub, auth);
  await new Promise<void>((r) => httpServer.listen(0, r));
  const httpPort = (httpServer.address() as any).port;

  wss = new WebSocketServer({ port: 0 });
  wss.on("connection", async (sock, req) => {
    const tok = tokenFromUpgrade(req);
    const p = await auth.authenticate(tok);
    const cAuth: ConnAuth = p
      ? { canRead: async (s) => can(await auth.roleOf(s, p.id), "read"), canWrite: async (s) => can(await auth.roleOf(s, p.id), "write") }
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
});

describe("EditorSession — live editing over the brain", () => {
  it("a whole-buffer save converges to a second session and fires onRemoteChange", async () => {
    const A = new EditorSession(base);
    const B = new EditorSession(base);
    await A.connect();
    await B.connect();

    const id = A.newNote({ title: "Doc", body: "line one\n" });
    await A.waitIdle();

    const remoteHits: string[] = [];
    B.onRemoteChange = (n) => remoteHits.push(n);
    B.openNote(id);
    await B.waitIdle();
    expect(B.bodyText(id)).toBe("line one\n");

    // edit like an editor would: replace the whole buffer with new text
    A.setBody(id, "line one\nline two\n");
    await A.waitIdle();
    await B.waitIdle();
    expect(B.bodyText(id)).toBe("line one\nline two\n");
    expect(remoteHits).toContain(id); // the FS provider would refresh on this

    A.disconnect();
    B.disconnect();
  });

  it("title is a last-writer-wins field, separate from the body buffer", async () => {
    const A = new EditorSession(base);
    const B = new EditorSession(base);
    await A.connect();
    await B.connect();

    const id = A.newNote({ title: "First", body: "x" });
    await A.waitIdle();
    A.setTitle(id, "Renamed");
    await A.waitIdle();

    B.openNote(id);
    await B.waitIdle();
    expect(B.title(id)).toBe("Renamed");
    expect(B.bodyText(id)).toBe("x");

    A.disconnect();
    B.disconnect();
  });

  it("interleaved edits to two regions both survive (minimal diff, not clobber)", async () => {
    const A = new EditorSession(base);
    const B = new EditorSession(base);
    await A.connect();
    await B.connect();

    const id = A.newNote({ title: "Two", body: "AAAA BBBB" });
    await A.waitIdle();
    B.openNote(id);
    await B.waitIdle();

    // A edits the head, B edits the tail — concurrent, non-overlapping
    A.setBody(id, "aaaa BBBB");
    B.setBody(id, "AAAA bbbb");
    await A.waitIdle();
    await B.waitIdle();
    await wait(50);

    // both replicas converge to the same text containing both edits
    const ta = A.bodyText(id);
    const tb = B.bodyText(id);
    expect(ta).toBe(tb);
    expect(ta).toContain("aaaa");
    expect(ta).toContain("bbbb");

    A.disconnect();
    B.disconnect();
  });

  it("an offline edit queues and flushes on reconnect", async () => {
    const A = new EditorSession(base);
    await A.connect();
    const id = A.newNote({ title: "Queue", body: "base" });
    await A.waitIdle();

    // simulate a network drop (not a clean disconnect)
    (A as any).ws.terminate();
    await wait(50);
    expect(A.connected).toBe(false);

    A.setBody(id, "base + offline");
    expect(A.status().dirty).toContain(id);

    await A.connect(); // handshake should push the queued edit
    await A.waitIdle();
    expect(A.status().dirty).not.toContain(id);

    const B = new EditorSession(base);
    await B.connect();
    B.openNote(id);
    await B.waitIdle();
    expect(B.bodyText(id)).toBe("base + offline");

    A.disconnect();
    B.disconnect();
  });

  it("search and pullScope cache a focus note plus its neighbors", async () => {
    const A = new EditorSession(base);
    await A.connect();
    const hub = A.newNote({ title: "Hubbb", body: "h" });
    const leaf = A.newNote({ title: "Leafff", body: "l" });
    A.link(hub, leaf, "depends_on");
    await A.waitIdle();
    A.disconnect();

    const C = new EditorSession(base);
    await C.connect();
    const ids = await C.pullScope(hub, 1);
    await C.waitIdle();
    expect(ids).toContain(hub);
    expect(ids).toContain(leaf);
    expect(C.title(leaf)).toBe("Leafff");

    const hits = await C.search("Hubbb");
    expect(hits.some((h) => h.id === hub)).toBe(true);
    C.disconnect();
  });
});
