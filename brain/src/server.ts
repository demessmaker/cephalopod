// The brain: persistent WebSocket sync relay + HTTP API + auth (M2).
// Run: npm start  (env: CEPH_DB, CEPH_PORT [ws], CEPH_HTTP_PORT)
import { WebSocketServer } from "ws";
import { SqliteStore } from "./store/sqlite.js";
import { SpaceHub, type ConnAuth } from "./hub.js";
import { embedderFromEnv } from "./embedder.js";
import { Auth, can } from "./auth.js";
import { createHttpServer } from "./http.js";
import { wsConn } from "./ws.js";
import { tokenFromUpgrade } from "./wsauth.js";
import type { ClientMsg, ServerMsg } from "./core/protocol.js";

const WS_PORT = Number(process.env.CEPH_PORT ?? 7700);
const HTTP_PORT = Number(process.env.CEPH_HTTP_PORT ?? 7701);
const DB = process.env.CEPH_DB ?? "./brain.db";
const wsRpm = Number(process.env.CEPH_WS_RATE_RPM ?? 1200); // per-principal WS message rate
const maxDocs = Number(process.env.CEPH_MAX_DOCS ?? 5000); // cap on resident in-memory docs

const store = new SqliteStore(DB);
const auth = new Auth(store);
const hub = new SpaceHub(store, {
  maxLoadedDocs: maxDocs,
  rateLimit: { capacity: wsRpm, refillPerSec: wsRpm / 60 },
  embedder: embedderFromEnv(), // CEPH_EMBED_URL routes through a real model; default = hashing
});

// First-run bootstrap: mint an admin principal + token. (ESM top-level await.)
const boot = await auth.bootstrapAdmin();
if (boot) {
  console.log(`\n🔑 bootstrap admin token (store it; shown once):\n   ${boot.token}\n`);
}

// HTTP API (per-token rate limit; CEPH_RATE_RPM requests/min, default 600)
const rpm = Number(process.env.CEPH_RATE_RPM ?? 600);
const http = createHttpServer(hub, auth, { rateLimit: { capacity: rpm, refillPerSec: rpm / 60 } });
http.listen(HTTP_PORT, () => console.log(`🐙 brain HTTP API on http://localhost:${HTTP_PORT}/v1`));

// WS sync relay — authenticate via Authorization header, the "bearer" subprotocol
// (browsers can't set headers, and a subprotocol keeps the token out of the URL),
// or a ?token= fallback; then enforce per-space ACL. Selecting the "bearer"
// subprotocol is required for the browser handshake to complete.
const wss = new WebSocketServer({
  port: WS_PORT,
  handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : false),
});
wss.on("connection", async (sock, req) => {
  const token = tokenFromUpgrade(req);
  const p = await auth.authenticate(token);
  const caps = await auth.capabilities(token);
  const connAuth: ConnAuth = p
    ? {
        canRead: async (s) => can(await auth.roleOf(s, p.id), "read"),
        canWrite: async (s) => can(await auth.roleOf(s, p.id), "write") && caps.mode !== "read", // read-only tokens can't write over WS
        kind: p.kind,
        principalId: p.id,
        caps, // capability scope (writeTags/pathPrefix) enforced on the WS write path
      }
    : { canRead: () => false, canWrite: () => false };
  const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock), connAuth);
  sock.on("close", () => hub.removeConnection(conn));
});
console.log(`🐙 brain WS relay on ws://localhost:${WS_PORT}`);

async function shutdown() {
  console.log("\nsnapshotting + closing…");
  await hub.snapshotAll();
  store.close();
  wss.close();
  http.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
