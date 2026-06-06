// WebSocket adapter: wrap a ws socket as a Conn (07 §11 step 8 smoke run).
import type { WebSocket } from "ws";
import type { Conn } from "./protocol.js";

export function wsConn<TSend, TRecv>(sock: WebSocket): Conn<TSend, TRecv> {
  return {
    send: (msg: TSend) => sock.send(JSON.stringify(msg)),
    onMessage: (cb: (msg: TRecv) => void) =>
      sock.on("message", (data) => cb(JSON.parse(data.toString()) as TRecv)),
  };
}
