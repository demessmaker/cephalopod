// C2: relay horizontal sharding. A single brain process owns its in-memory Y.Docs
// and fans updates to the connections attached to *it*. To run more than one brain
// instance behind a load balancer (sharing one Postgres store), each committed
// delta must also reach the instances that hold *other* live connections to the
// same note. The `Broadcaster` is that seam: publish a delta, and receive deltas
// other instances published.
//
// Production binds this to a broker (NATS / Redis pub-sub / Postgres LISTEN-NOTIFY);
// the default is single-instance (no broadcaster) and tests use an in-process
// `LocalBus`. The store is the source of truth — broadcast is a liveness optimization
// (fan-out + cache coherence), never the persistence path.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface BroadcastMsg {
  origin: string; // instance id that produced it (recipients skip their own)
  space: string;
  note: string;
  update: string; // b64 raw CRDT delta (same wire form as a WS `update`)
  seq: number; // the store's monotonic log seq — lets recipients dedup redelivery
}

export interface Broadcaster {
  readonly id: string; // this instance's origin id
  publish(msg: BroadcastMsg): void | Promise<void>;
  // Register a handler; returns an unsubscribe fn (SpaceHub.close calls it so a torn
  // -down hub stops processing messages and doesn't leak a listener on the broker).
  subscribe(handler: (msg: BroadcastMsg) => void): () => void;
}

// In-process fan-out bus shared by multiple SpaceHub instances — stands in for a
// real broker behind the same seam. `connect()` returns a per-instance Broadcaster
// tagged with a unique origin id; messages are delivered to *every* connected
// instance (including the publisher, mirroring a real pub-sub topic), so the hub
// is responsible for skipping its own origin.
export class LocalBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  connect(id: string = randomUUID()): Broadcaster {
    const emitter = this.emitter;
    return {
      id,
      publish(msg: BroadcastMsg) {
        emitter.emit("msg", msg);
      },
      subscribe(handler: (msg: BroadcastMsg) => void) {
        emitter.on("msg", handler);
        return () => emitter.off("msg", handler);
      },
    };
  }
}
