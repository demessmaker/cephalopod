// M2 acceptance: HTTP API, auth/ACL, and full-text search over real HTTP.
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

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = auth.bootstrapAdmin()!.token;
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
});
afterAll(() => {
  server.close();
  store.close();
});

async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("M2 brain — HTTP API + auth + search", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await api("GET", "/spaces", null)).status).toBe(401);
    expect((await api("GET", "/spaces", "cph_bogus")).status).toBe(401);
  });

  it("admin can create a space, notes, and read them back", async () => {
    expect((await api("POST", "/spaces", adminToken, { name: "eng" })).status).toBe(201);
    const create = await api("POST", "/spaces/eng/notes", adminToken, {
      title: "Billing Service",
      body: "charges customers; depends on [[Gateway]]",
      tags: ["service", "tier:1"],
    });
    expect(create.status).toBe(201);
    const id = create.body.id;
    const got = await api("GET", `/spaces/eng/notes/${id}`, adminToken);
    expect(got.status).toBe(200);
    expect(got.body.title).toBe("Billing Service");
    expect(got.body.tags).toContain("service");
  });

  it("full-text search finds notes by title/body", async () => {
    await api("POST", "/spaces/eng/notes", adminToken, { title: "Idempotency", body: "avoid double charging" });
    const r = await api("GET", "/spaces/eng/search?q=charging", adminToken);
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBeGreaterThan(0);
    const tags = await api("GET", "/spaces/eng/tags", adminToken);
    expect(tags.body.tags.some((t: any) => t.tag === "service")).toBe(true);
  });

  it("links + neighbors + backlinks work over HTTP", async () => {
    const a = (await api("POST", "/spaces/eng/notes", adminToken, { title: "A" })).body.id;
    const b = (await api("POST", "/spaces/eng/notes", adminToken, { title: "B" })).body.id;
    expect((await api("POST", "/spaces/eng/links", adminToken, { from: a, to: b, type: "depends_on" })).status).toBe(201);
    const nb = await api("GET", `/spaces/eng/notes/${a}/neighbors?hops=1`, adminToken);
    expect(nb.body.edges.some((e: any) => e.to === b && e.type === "depends_on")).toBe(true);
    const back = await api("GET", `/spaces/eng/notes/${b}/backlinks`, adminToken);
    expect(back.body.edges.map((e: any) => e.from)).toContain(a);
  });

  it("enforces per-space roles (viewer cannot write)", async () => {
    // admin mints a viewer principal and grants viewer role
    const p = await api("POST", "/principals", adminToken, { kind: "user", name: "reader" });
    const viewerToken = p.body.token;
    const viewerId = p.body.principal.id;
    await api("POST", "/spaces/eng/members", adminToken, { principalId: viewerId, role: "viewer" });

    // viewer can read
    expect((await api("GET", "/spaces/eng/tags", viewerToken)).status).toBe(200);
    // viewer cannot write
    expect((await api("POST", "/spaces/eng/notes", viewerToken, { title: "nope" })).status).toBe(403);

    // a non-member sees 403 even for reads
    const outsider = (await api("POST", "/principals", adminToken, { kind: "agent", name: "stranger" })).body.token;
    expect((await api("GET", "/spaces/eng/tags", outsider)).status).toBe(403);
  });

  it("404s for missing notes and reflects deletes", async () => {
    expect((await api("GET", "/spaces/eng/notes/n_missing", adminToken)).status).toBe(404);
    const id = (await api("POST", "/spaces/eng/notes", adminToken, { title: "Temp" })).body.id;
    expect((await api("DELETE", `/spaces/eng/notes/${id}`, adminToken)).status).toBe(200);
    expect((await api("GET", `/spaces/eng/notes/${id}`, adminToken)).status).toBe(404);
  });
});
