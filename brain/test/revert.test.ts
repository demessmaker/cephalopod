// N6: reversibility (05 §4) — an admin reverts a principal's edits since a time,
// while other principals' edits survive. History-preserving.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server, store: SqliteStore, port: number;
let admin: string, agentId: string, agentToken: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  admin = auth.bootstrapAdmin()!.token;
  const agent = auth.createPrincipal("agent", "rogue");
  agentId = agent.id;
  agentToken = auth.issueToken(agent.id);
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await api("POST", "/spaces", admin, { name: "kb" });
  await api("PUT", "/spaces/kb/settings", admin, { agentMode: "open" }); // let the agent write live, so we can revert it
  await api("POST", "/spaces/kb/members", admin, { principalId: agent.id, role: "editor" });
});
afterAll(() => server.close());

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("N6 — reversibility", () => {
  it("reverts a principal's edits since T, preserving others' and earlier edits", async () => {
    // human creates a note with good content
    const id = (await api("POST", "/spaces/kb/notes", admin, { title: "Service", body: "good docs", tags: ["service"] })).body.id;
    await wait(5);
    const T = Date.now();
    await wait(5);

    // the agent then corrupts it (after T)
    await api("PATCH", `/spaces/kb/notes/${id}`, agentToken, { body: "POISONED by agent", tags: ["service", "bogus"] });
    // and adds a junk note
    const junk = (await api("POST", "/spaces/kb/notes", agentToken, { title: "Junk", body: "agent spam" })).body.id;
    expect((await api("GET", `/spaces/kb/notes/${id}`, admin)).body.body).toBe("POISONED by agent");

    // admin reverts the agent's edits since T
    const r = await api("POST", "/spaces/kb/revert", admin, { principalId: agentId, since: T });
    expect(r.status).toBe(200);
    expect(r.body.reverted).toContain(id);
    expect(r.body.reverted).toContain(junk);
    expect(r.body.partial).toEqual([]); // nothing was compacted, so the revert is complete

    // the human's original content is restored…
    const snap = await api("GET", `/spaces/kb/notes/${id}`, admin);
    expect(snap.body.body).toBe("good docs");
    expect(snap.body.tags).toContain("service");
    expect(snap.body.tags).not.toContain("bogus");
    // …and the agent's junk note is reverted to empty (its create is undone)
    const junkSnap = await api("GET", `/spaces/kb/notes/${junk}`, admin);
    expect(junkSnap.body.title).toBe("");
    expect(junkSnap.body.body).toBe("");
  });

  it("requires admin", async () => {
    expect((await api("POST", "/spaces/kb/revert", agentToken, { principalId: agentId, since: 0 })).status).toBe(403);
  });

  it("validates the since timestamp", async () => {
    expect((await api("POST", "/spaces/kb/revert", admin, { principalId: agentId, since: "not-a-date" })).status).toBe(400);
  });

  it("requires `since` (won't default to reverting all history)", async () => {
    expect((await api("POST", "/spaces/kb/revert", admin, { principalId: agentId })).status).toBe(400);
    expect((await api("POST", "/spaces/kb/revert", admin, { principalId: agentId, since: "" })).status).toBe(400);
  });
});

describe("N6 — reversibility across compaction", () => {
  it("flags notes as `partial` when the actor's edits were compacted into a snapshot", async () => {
    const store2 = new SqliteStore(":memory:");
    const auth = new Auth(store2);
    const hub = new SpaceHub(store2, { snapshotEvery: 2 }); // compact aggressively
    const adminTok = auth.bootstrapAdmin()!.token;
    const bot = auth.createPrincipal("agent", "rogue3");
    const botTok = auth.issueToken(bot.id);
    const srv = createHttpServer(hub, auth);
    await new Promise<void>((r) => srv.listen(0, r));
    const p = (srv.address() as any).port;
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await fetch(`http://localhost:${p}/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await call("POST", "/spaces", adminTok, { name: "kb2" });
    await call("PUT", "/spaces/kb2/settings", adminTok, { agentMode: "open" });
    await call("POST", "/spaces/kb2/members", adminTok, { principalId: bot.id, role: "editor" });

    const T = Date.now();
    await wait(5);
    // the agent edits one note many times; with snapshotEvery=2 the early edits get
    // folded into a snapshot (compacted) and can't be fully reverted.
    const id = (await call("POST", "/spaces/kb2/notes", botTok, { title: "Doc", body: "v1" })).body.id;
    for (const v of ["v2", "v3", "v4", "v5"]) await call("PATCH", `/spaces/kb2/notes/${id}`, botTok, { body: v });

    const r = await call("POST", "/spaces/kb2/revert", adminTok, { principalId: bot.id, since: T });
    expect(r.body.reverted).toContain(id); // tail edits were dropped
    expect(r.body.partial).toContain(id); // but earlier ones were baked into a snapshot
    srv.close();
    store2.close();
  });
});
