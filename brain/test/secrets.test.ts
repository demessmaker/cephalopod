// N5: secret-scanning on write + hard-purge (05 §5).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { scanSecrets } from "../src/secrets.js";

describe("secret scanner", () => {
  it("detects common secret shapes, ignores clean text", () => {
    expect(scanSecrets("key AKIAIOSFODNN7EXAMPLE here")).toContain("aws-access-key");
    expect(scanSecrets("token ghp_" + "a".repeat(36))).toContain("github-token");
    expect(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private-key-block");
    expect(scanSecrets("just a normal runbook about deploys")).toEqual([]);
  });
});

let server: Server, store: SqliteStore, port: number, adminToken: string, editorToken: string;
const AWS = "AKIAIOSFODNN7EXAMPLE";

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  adminToken = auth.bootstrapAdmin()!.token;
  const ed = auth.createPrincipal("user", "ed");
  editorToken = auth.issueToken(ed.id);
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await api("POST", "/spaces", adminToken, { name: "sec" });
  await api("POST", "/spaces/sec/members", adminToken, { principalId: ed.id, role: "editor" });
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

describe("N5 — secret scanning policy", () => {
  it("warn (default): writes a secret-bearing note tagged #secret-suspected", async () => {
    const r = await api("POST", "/spaces/sec/notes", adminToken, { title: "Config", body: `aws=${AWS}` });
    expect(r.status).toBe(201);
    const snap = await api("GET", `/spaces/sec/notes/${r.body.id}`, adminToken);
    expect(snap.body.tags).toContain("secret-suspected");
  });

  it("block: rejects a secret-bearing write with 422 secret_suspected", async () => {
    await api("PUT", "/spaces/sec/settings", adminToken, { secretScan: "block" });
    const r = await api("POST", "/spaces/sec/notes", adminToken, { title: "Leak", body: `key ${AWS}` });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("secret_suspected");
    expect(r.body.patterns).toContain("aws-access-key");
  });

  it("off: no scanning", async () => {
    await api("PUT", "/spaces/sec/settings", adminToken, { secretScan: "off" });
    const r = await api("POST", "/spaces/sec/notes", adminToken, { title: "Raw", body: `key ${AWS}` });
    expect(r.status).toBe(201);
    const snap = await api("GET", `/spaces/sec/notes/${r.body.id}`, adminToken);
    expect(snap.body.tags).not.toContain("secret-suspected");
  });
});

describe("N5 — hard purge", () => {
  it("admin purge expunges a note from reads, search and the index", async () => {
    await api("PUT", "/spaces/sec/settings", adminToken, { secretScan: "off" });
    const id = (await api("POST", "/spaces/sec/notes", adminToken, { title: "Purge Me", body: "ephemeral secret material" })).body.id;
    expect((await api("GET", "/spaces/sec/search?q=ephemeral", adminToken)).body.hits.map((h: any) => h.id)).toContain(id);

    // non-admin cannot purge
    expect((await api("POST", `/spaces/sec/notes/${id}/purge`, editorToken)).status).toBe(403);

    const purged = await api("POST", `/spaces/sec/notes/${id}/purge`, adminToken);
    expect(purged.status).toBe(200);
    expect((await api("GET", `/spaces/sec/notes/${id}`, adminToken)).status).toBe(404);
    expect((await api("GET", "/spaces/sec/search?q=ephemeral", adminToken)).body.hits).toHaveLength(0);
    // log is gone too: a fresh store on the same db would not rehydrate it
    expect(store.loadDoc("sec", id).updates).toHaveLength(0);
    expect(store.loadDoc("sec", id).snapshot).toBeUndefined();
  });
});
