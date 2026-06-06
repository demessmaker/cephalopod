// §11 step 8 — real-WebSocket smoke run: confirm convergence isn't an
// in-memory artifact. Starts a relay over ws, connects two arms, edits on A,
// asserts B converges. Run: npm run smoke
import { WebSocketServer, WebSocket } from "ws";
import { Relay } from "./relay.js";
import { Client } from "./client.js";
import { wsConn } from "./ws.js";
import { newNoteId } from "./note.js";
import type { ClientMsg, ServerMsg } from "./protocol.js";

const PORT = 7700;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const relay = new Relay();
  const wss = new WebSocketServer({ port: PORT });
  wss.on("connection", (sock) => relay.addConnection(wsConn<ServerMsg, ClientMsg>(sock)));
  await wait(100);

  const dial = () =>
    new Promise<WebSocket>((res) => {
      const s = new WebSocket(`ws://localhost:${PORT}`);
      s.on("open", () => res(s));
    });

  const A = new Client("A", wsConn<ClientMsg, ServerMsg>(await dial()));
  const B = new Client("B", wsConn<ClientMsg, ServerMsg>(await dial()));

  const id = newNoteId();
  A.open(id);
  B.open(id);
  await wait(50);

  A.setTitle(id, "Hello over the wire");
  A.appendBody(id, "real ws delta with [[Linked Note]]");
  await wait(100);

  const bodyB = B.note(id).body.toString();
  const titleB = B.title(id);
  const slice = await A.subscribe({ focus: [id], hops: 1 });

  const ok =
    bodyB.includes("real ws delta") &&
    titleB === "Hello over the wire" &&
    slice.edges.some((e) => e.origin === "wikilink");

  console.log(`B.title = ${JSON.stringify(titleB)}`);
  console.log(`B.body  = ${JSON.stringify(bodyB)}`);
  console.log(`slice   = ${slice.nodes.length} nodes, ${slice.edges.length} edges`);
  console.log(ok ? "\n✅ WS smoke: converged over real WebSockets" : "\n❌ WS smoke FAILED");

  wss.close();
  process.exit(ok ? 0 : 1);
}

main();
