# Cephalopod — Security, Access Control & Attribution

Team knowledge is sensitive (architecture, incidents, credentials-adjacent
runbooks) and — critically — **agents** read and write it. Access control and
attribution are core, not afterthoughts.

## 1. Identity

Two principal types, both first-class:

- **Users** — humans, authenticated via the org's IdP (OIDC/SAML) or tokens.
- **Agents** — automated principals (an MCP client, a CI job, an indexer). Each
  has its own identity and token, *never* shares a human's credentials.

Every principal has a stable `principalId` used for ACL and attribution. Agent
identities are issued by an admin/owner and can be tied to a sponsoring user
("agent acting on behalf of") for accountability.

## 2. Access control model

### 2.1 Spaces as the ACL boundary
A **space** is the unit of access control. A principal has a role in a space:

| Role | Read | Write notes/links | Manage tags/schema conventions | Admin (ACL, purge) |
|------|------|-------------------|-------------------------------|--------------------|
| `viewer` | ✓ | | | |
| `editor` | ✓ | ✓ | ✓ | |
| `admin` | ✓ | ✓ | ✓ | ✓ |

### 2.2 Sub-space scoping (capabilities)
Because agents should often be *narrowly* scoped, tokens can carry **capability
constraints** narrower than the role:

- **Tag scope**: `read:#runbook`, `write:#decision` — limit to notes carrying
  (or being tagged with) given tags.
- **Path scope**: limit to a `props.path` prefix (e.g. `billing/**`).
- **Mode**: read-only vs read-write.
- **Note allow/deny lists** for fine cases.

Capabilities **intersect** with the role (never widen it). Example: an indexer
agent gets `editor`-in-space but capability `read-only + all`, so it can build
indexes but not mutate knowledge.

### 2.3 Enforcement points
ACL/capability checks happen at every boundary that touches data:

- WebSocket `SUBSCRIBE` — scope filtered to what the principal may read; notes
  outside scope are never streamed.
- WebSocket `UPDATE` — rejected before apply/fan-out if the principal can't write
  the target doc (relay refuses the delta; CRDT state is never mutated by an
  unauthorized actor).
- HTTP/MCP calls — checked per request against the resolved capability set.

Because reads are enforced at *stream* time, an arm can only cache what it's
allowed to see — there's no client-side filtering of over-shared data.

## 3. Attribution & audit

- The **update log** records `{principalId, ts, doc, deltaBytes}` for every
  change → complete, tamper-evident audit trail per space.
- **Blame**: Yjs client ids are mapped to principals, enabling per-field /
  per-text-range attribution ("who wrote this sentence", "which agent added this
  link").
- Agent writes are visibly attributed in UIs and in `get_note` metadata so a
  human can always tell human- vs agent-authored knowledge apart.
- Admin actions (ACL changes, hard purge) are themselves logged.

## 4. Trust & safety for agent writes

Agents writing to shared memory is powerful and risky. Mitigations:

- **Provenance flag**: notes/edges carry `props.authoredBy = agent|human|mixed`;
  queries can filter (e.g. "human-verified decisions only").
- **Draft-gate by default**: agent-authored notes are created as `#draft` and are
  excluded from the "live" knowledge set (default queries, resource listings)
  until a human `editor` promotes them. Implemented as a tag convention
  (`#draft`) plus a capability that limits agent tokens to creating/editing
  `#draft` notes. A space may **opt out per-space** to grant agents full write
  autonomy (or tighten further) in its settings — but the secure default is on.
- **Rate limits & quotas** per token to bound runaway agents.
- **Reversibility**: every change is a CRDT delta in the log; an admin can
  revert an agent's recent edits by applying inverse deltas (soft) without
  destroying history.

## 5. Secrets hygiene

- Cephalopod is **not** a secrets store. A server-side scanner flags notes whose
  content matches secret patterns (API keys, tokens) on write and warns/blocks
  per policy.
- **Hard purge** (`02-crdt-sync.md §5`) exists for the case where a secret or PII
  lands in the graph: it rewrites log + snapshots and force-resyncs arms. Audited
  and admin-only.

## 6. Transport & storage security

- All transport over TLS (HTTPS/WSS).
- At rest: log + snapshots encrypted; per-space encryption keys for SaaS multi-
  tenancy so spaces are cryptographically isolated.
- Tokens are short-lived + refreshable; agent tokens revocable instantly (relay
  drops connections on revocation).

## 7. Open security questions

- End-to-end encryption (server can't read content) vs server-side search/
  embeddings — these conflict; default is server-readable for search. (OQ-6)
- Granularity below the note (field-level ACL) — deferred; ACL is per note/scope.
- Federation/sharing a subgraph read-only with another org — future.
