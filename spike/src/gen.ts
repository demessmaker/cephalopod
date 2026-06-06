// §9 M-load — synthetic graph generator + scope-resolution benchmark.
// Run: npm run gen   (scale with CEPH_SCALE=50000 npm run gen)
import { Relay } from "./relay.js";
import { Client } from "./client.js";
import { createPair } from "./memtransport.js";
import { newNoteId } from "./note.js";
import type { ClientMsg, ServerMsg } from "./protocol.js";

async function main() {
  const N = Number(process.env.CEPH_SCALE ?? 50000);
  const relay = new Relay();
  const pair = createPair<ClientMsg, ServerMsg>();
  relay.addConnection(pair.server);
  const A = new Client("gen", pair.client);

  const ids: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const id = newNoteId();
    ids.push(id);
    A.open(id);
    // build a sparse graph: each node links to ~3 earlier nodes
    if (i > 3) {
      A.link(id, ids[i - 1]);
      A.link(id, ids[(i / 2) | 0]);
      A.link(id, ids[(i / 3) | 0]);
    }
  }
  const buildMs = performance.now() - t0;

  const focus = ids[(N / 2) | 0];
  for (const hops of [1, 2, 3]) {
    const t = performance.now();
    const slice = await A.subscribe({ focus: [focus], hops });
    const ms = performance.now() - t;
    console.log(
      `hops=${hops}: ${ms.toFixed(2)} ms -> ${slice.nodes.length} nodes, ${slice.edges.length} edges`,
    );
  }
  console.log(`\nbuilt ${N} nodes (+~3 edges each) in ${buildMs.toFixed(0)} ms`);
  process.exit(0);
}

main();
