// C1 end-to-end: the async SpaceHub + HTTP API driven by a POSTGRES backend
// (PgStore on in-process PGlite) — proving the whole stack runs on Postgres, not
// just SQLite. Exercises create/search/neighbors and agent draft-gating.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PgStore } from "../src/store/pg.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server, port: number, admin: string, agentToken: string;
let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  const store = new PgStore(pg);
  await store.init();
  const auth = new Auth(store); // hub/auth accept an AsyncStore directly
  const hub = new SpaceHub(store);
  admin = (await auth.bootstrapAdmin())!.token;
  const agent = await auth.createPrincipal("agent", "bot");
  agentToken = await auth.issueToken(agent.id);
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await api("POST", "/spaces", admin, { name: "kb" });
  await api("POST", "/spaces/kb/members", admin, { principalId: agent.id, role: "editor" });
});
afterAll(async () => {
  server.close();
  await pg.close();
});

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("Postgres-backed brain (async hub on PGlite)", () => {
  it("creates, indexes, full-text searches and traverses on Postgres", async () => {
    const id = (await api("POST", "/spaces/kb/notes", admin, { title: "Billing", body: "charges customers; uses [[Gateway]]" })).body.id;
    // FTS (native tsvector)
    expect((await api("GET", "/spaces/kb/search?q=charges", admin)).body.hits.map((h: any) => h.id)).toContain(id);
    // derived graph index + wikilink stub
    const nb = await api("GET", `/spaces/kb/notes/${id}/neighbors?hops=1`, admin);
    expect(nb.body.nodes.some((n: any) => n.title === "Gateway" && n.stub)).toBe(true);
    expect(nb.body.edges.some((e: any) => e.origin === "wikilink")).toBe(true);
  });

  it("enforces agent draft-gating end-to-end on Postgres", async () => {
    const r = await api("POST", "/spaces/kb/notes", agentToken, { title: "Agent Note", body: "needs review" });
    expect(r.body.draft).toBe(true);
    const snap = await api("GET", `/spaces/kb/notes/${r.body.id}`, agentToken);
    expect(snap.body.tags).toContain("draft");
    expect(snap.body.props.authoredBy).toBe("agent");
    // hidden from default discovery, visible with drafts=1
    expect((await api("GET", "/spaces/kb/search?q=review", admin)).body.hits).toHaveLength(0);
    expect((await api("GET", "/spaces/kb/search?q=review&drafts=1", admin)).body.hits.map((h: any) => h.id)).toContain(r.body.id);
  });

  it("semantic/hybrid search works on the Postgres backend", async () => {
    await api("POST", "/spaces/kb/notes", admin, { title: "Payments", body: "processing customer payments and charges" });
    const hits = (await api("GET", "/spaces/kb/search?q=payments&mode=hybrid", admin)).body.hits;
    expect(hits.length).toBeGreaterThan(0);
  });
});
