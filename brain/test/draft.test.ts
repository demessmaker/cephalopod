// M6 acceptance: agent draft-gating (05 §4). Agent writes are stamped + forced
// to #draft (excluded from discovery) until a human promotes them; agents can
// only edit their own drafts; per-space opt-out switches to open mode.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server;
let port: number;
let store: SqliteStore;
let adminToken: string;
let userToken: string;
let agentToken: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = (await auth.bootstrapAdmin())!.token;
  const user = await auth.createPrincipal("user", "human-dev");
  userToken = await auth.issueToken(user.id);
  const agent = await auth.createPrincipal("agent", "indexer");
  agentToken = await auth.issueToken(agent.id);
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  // admin creates space "kb" (default draft mode) and grants both editor
  await api("POST", "/spaces", adminToken, { name: "kb" });
  await api("POST", "/spaces/kb/members", adminToken, { principalId: user.id, role: "editor" });
  await api("POST", "/spaces/kb/members", adminToken, { principalId: agent.id, role: "editor" });
});
afterAll(() => {
  server.close();
  store.close();
});

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("M6 — agent draft-gating", () => {
  it("agent-created notes are stamped #draft and hidden from discovery", async () => {
    const r = await api("POST", "/spaces/kb/notes", agentToken, { title: "Agent Finding", body: "billing retries are not idempotent" });
    expect(r.body.draft).toBe(true);
    const id = r.body.id;
    const snap = await api("GET", `/spaces/kb/notes/${id}`, agentToken);
    expect(snap.body.tags).toContain("draft");
    expect(snap.body.props.authoredBy).toBe("agent");

    // hidden from search + listing by default…
    expect((await api("GET", "/spaces/kb/search?q=idempotent", userToken)).body.hits).toHaveLength(0);
    expect((await api("GET", "/spaces/kb/notes", userToken)).body.notes.find((n: any) => n.id === id)).toBeUndefined();
    // …but visible when explicitly including drafts
    expect((await api("GET", "/spaces/kb/search?q=idempotent&drafts=1", userToken)).body.hits.map((h:any)=>h.id)).toContain(id);
  });

  it("human writes are stamped human and live (not drafted)", async () => {
    const r = await api("POST", "/spaces/kb/notes", userToken, { title: "Runbook", body: "rollback procedure" });
    const snap = await api("GET", `/spaces/kb/notes/${r.body.id}`, userToken);
    expect(snap.body.tags).not.toContain("draft");
    expect(snap.body.props.authoredBy).toBe("human");
    expect((await api("GET", "/spaces/kb/search?q=rollback", userToken)).body.hits.map((h:any)=>h.id)).toContain(r.body.id);
  });

  it("agents can edit their own drafts but not live notes, and cannot self-promote", async () => {
    const draft = (await api("POST", "/spaces/kb/notes", agentToken, { title: "D", body: "x" })).body.id;
    const live = (await api("POST", "/spaces/kb/notes", userToken, { title: "L", body: "y" })).body.id;

    // editing own draft: ok, and draft tag is preserved even if omitted
    const ok = await api("PATCH", `/spaces/kb/notes/${draft}`, agentToken, { body: "x2", tags: ["service"] });
    expect(ok.status).toBe(200);
    expect(ok.body.tags).toContain("draft");

    // editing a live note: forbidden
    expect((await api("PATCH", `/spaces/kb/notes/${live}`, agentToken, { body: "nope" })).status).toBe(403);
    // promoting: forbidden for agents
    expect((await api("POST", `/spaces/kb/notes/${draft}/promote`, agentToken)).status).toBe(403);
  });

  it("a human can promote an agent draft into the live set", async () => {
    const id = (await api("POST", "/spaces/kb/notes", agentToken, { title: "Promote Me", body: "graphql migration notes" })).body.id;
    expect((await api("GET", "/spaces/kb/search?q=graphql", userToken)).body.hits).toHaveLength(0);
    const promoted = await api("POST", `/spaces/kb/notes/${id}/promote`, userToken);
    expect(promoted.status).toBe(200);
    expect(promoted.body.tags).not.toContain("draft");
    expect((await api("GET", "/spaces/kb/search?q=graphql", userToken)).body.hits.map((h:any)=>h.id)).toContain(id);
  });

  it("a space can opt out (open mode): agent writes go live", async () => {
    await api("POST", "/spaces", adminToken, { name: "open-kb" });
    const agentId = (await api("POST", "/principals", adminToken, { kind: "agent", name: "a2" })).body;
    // reuse our agent: grant editor on open-kb and switch the space to open
    await api("POST", "/spaces/open-kb/members", adminToken, { principalId: agentId.principal.id, role: "editor" });
    expect((await api("PUT", "/spaces/open-kb/settings", adminToken, { agentMode: "open" })).status).toBe(200);

    const r = await api("POST", "/spaces/open-kb/notes", agentId.token, { title: "Open Note", body: "kafka tuning" });
    expect(r.body.draft).toBe(false);
    expect((await api("GET", "/spaces/open-kb/search?q=kafka", adminToken)).body.hits.map((h:any)=>h.id)).toContain(r.body.id);
  });
});
