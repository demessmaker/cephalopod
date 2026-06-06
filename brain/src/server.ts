// The brain: persistent WebSocket sync relay + HTTP API + auth (M2).
// Run: npm start  (env: CEPH_DB, CEPH_PORT [ws], CEPH_HTTP_PORT)
import { WebSocketServer } from "ws";
import { SqliteStore } from "./store/sqlite.js";
import { SpaceHub, type ConnAuth } from "./hub.js";
import { Auth, can } from "./auth.js";
import { createHttpServer } from "./http.js";
import { wsConn } from "./ws.js";
import type { ClientMsg, ServerMsg } from "./core/protocol.js";

const WS_PORT = Number(process.env.CEPH_PORT ?? 7700);
const HTTP_PORT = Number(process.env.CEPH_HTTP_PORT ?? 7701);
const DB = process.env.CEPH_DB ?? "./brain.db";

const store = new SqliteStore(DB);
const auth = new Auth(store);
const hub = new SpaceHub(store);

// First-run bootstrap: mint an admin principal + token.
const boot = auth.bootstrapAdmin();
if (boot) {
  console.log(`\n🔑 bootstrap admin token (store it; shown once):\n   ${boot.token}\n`);
}

// HTTP API
const http = createHttpServer(hub, auth);
http.listen(HTTP_PORT, () => console.log(`🐙 brain HTTP API on http://localhost:${HTTP_PORT}/v1`));

// WS sync relay — authenticate via ?token= and enforce per-space ACL.
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (sock, req) => {
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
  const p = auth.authenticate(token);
  const caps = auth.capabilities(token);
  const connAuth: ConnAuth = p
    ? {
        canRead: (s) => can(auth.roleOf(s, p.id), "read"),
        canWrite: (s) => can(auth.roleOf(s, p.id), "write") && caps.mode !== "read", // read-only tokens can't write over WS
        kind: p.kind,
      }
    : { canRead: () => false, canWrite: () => false };
  const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), connAuth);
  sock.on("close", () => hub.removeConnection(conn));
});
console.log(`🐙 brain WS relay on ws://localhost:${WS_PORT}`);

function shutdown() {
  console.log("\nsnapshotting + closing…");
  hub.snapshotAll();
  store.close();
  wss.close();
  http.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
