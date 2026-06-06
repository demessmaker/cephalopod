// In-process transport for deterministic tests (07 §3, §10). Delivery is
// synchronous when the link is connected; disconnect() drops messages both ways
// to simulate offline (Yjs reconciles via the state-vector handshake on
// reconnect, so we don't need to buffer individual updates).
import type { Conn } from "./protocol.js";

interface Link {
  connected: boolean;
}

class Channel<TSend, TRecv> implements Conn<TSend, TRecv> {
  peer!: Channel<TRecv, TSend>;
  handler?: (msg: TRecv) => void;
  constructor(private link: Link) {}
  send(msg: TSend): void {
    // peer is Channel<TRecv, TSend>, so its handler accepts TSend.
    if (this.link.connected && this.peer.handler) this.peer.handler(msg);
  }
  onMessage(cb: (msg: TRecv) => void): void {
    this.handler = cb;
  }
}

export interface Pair<C, S> {
  client: Conn<C, S>;
  server: Conn<S, C>;
  disconnect(): void;
  reconnect(): void;
}

export function createPair<C, S>(): Pair<C, S> {
  const link: Link = { connected: true };
  const client = new Channel<C, S>(link);
  const server = new Channel<S, C>(link);
  client.peer = server;
  server.peer = client;
  return {
    client,
    server,
    disconnect: () => (link.connected = false),
    reconnect: () => (link.connected = true),
  };
}
