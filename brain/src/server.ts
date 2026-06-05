// The brain: a persistent WebSocket sync relay (M1). Log + snapshots + spaces.
// Run: npm start   (env: CEPH_DB=./brain.db CEPH_PORT=7700)
import { WebSocketServer } from "ws";
import { SqliteStore } from "./store/sqlite.js";
import { SpaceHub } from "./hub.js";
import { wsConn } from "./ws.js";
import type { ClientMsg, ServerMsg } from "./core/protocol.js";

const PORT = Number(process.env.CEPH_PORT ?? 7700);
const DB = process.env.CEPH_DB ?? "./brain.db";

const store = new SqliteStore(DB);
const hub = new SpaceHub(store);
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (sock) => {
  const conn = hub.addConnection(wsConn<ServerMsg, ClientMsg>(sock));
  sock.on("close", () => hub.removeConnection(conn));
});

console.log(`🐙 cephalopod brain listening on ws://localhost:${PORT} (db: ${DB})`);

function shutdown() {
  console.log("\nsnapshotting + closing…");
  hub.snapshotAll();
  store.close();
  wss.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
