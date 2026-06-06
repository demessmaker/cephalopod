# Cephalopod — CLI Arm (Phase 1 / M3)

A developer's local **arm**: a persistent CRDT replica of the subgraph you're
working on. Cache a scope, edit offline, and stream deltas to the brain — the
"arms with a local cache + delta push" half of the cephalopod topology.

> Builds on the M0 spike's convergence client, against the real brain protocol
> (space + token auth). Specs: `02-crdt-sync.md §3`, `06-roadmap.md` (M3).

## Status — M3 done

- ✅ **Local replica** of cached notes (per-note Yjs docs).
- ✅ **Offline cache on disk** (`<cache>/<space>/<id>.ydoc` + `manifest.json`) —
  survives restarts.
- ✅ **Offline edits** apply locally and reconcile on reconnect via the
  state-vector handshake (no lost edits).
- ✅ **Pull a scope** (focus + N hops) from the brain into the cache.
- ✅ **Two arms converge** through the brain (verified end-to-end).

## Run

```bash
npm install
npm test            # 3 tests: convergence, offline-restart-sync, pull scope (real brain)

export CEPH_SPACE=eng CEPH_TOKEN=<token> CEPH_CACHE=./.cache
export CEPH_WS_URL=ws://localhost:7700 CEPH_HTTP_URL=http://localhost:7701

npm run arm -- new "Design Doc" "draft about [[Auth]]"   # create (syncs if online)
npm run arm -- pull <noteId> 2                            # cache a 2-hop neighborhood
npm run arm -- append <id> " more text"                  # edit (offline-capable)
npm run arm -- ls                                         # list cached notes
npm run arm -- cat <id>                                   # print a cached note
npm run arm -- sync                                       # reconcile with the brain
npm run arm -- search "rollback"                          # brain full-text search
```

Offline (brain unreachable), edits are cached and pushed on the next online
command.

## Notes / limits

- The `status` "dirty" indicator is **per-process** (the CLI is one-shot), so it
  may read empty across separate invocations. Sync correctness does not depend on
  it — every (re)connect reconciles via Yjs state vectors, so cached offline edits
  are always pushed.
- Scope subscriptions aren't live here (use the MCP server for live agent
  notifications). The arm pulls/reconciles on command.
