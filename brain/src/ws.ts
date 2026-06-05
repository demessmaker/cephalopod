// WebSocket adapter: wrap a ws socket as a Conn.
import type { WebSocket } from "ws";
import type { Conn } from "./core/protocol.js";

export function wsConn<TSend, TRecv>(sock: WebSocket): Conn<TSend, TRecv> {
  return {
    send: (msg: TSend) => {
      if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
    },
    onMessage: (cb: (msg: TRecv) => void) =>
      sock.on("message", (data) => {
        try {
          cb(JSON.parse(data.toString()) as TRecv);
        } catch {
          /* ignore malformed frames in the spike-grade server */
        }
      }),
  };
}
