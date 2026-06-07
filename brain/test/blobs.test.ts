// Track D: attachments / blob store over the HTTP API — binary upload + download,
// content-addressed dedupe, per-space + auth gating, and the size cap.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server, port: number, admin: string, reader: string, store: SqliteStore;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store, { maxBlobBytes: 1024 }); // tiny cap to exercise 413
  admin = (await auth.bootstrapAdmin())!.token;
  const r = await auth.createPrincipal("user", "reader");
  reader = await auth.issueToken(r.id);
  server = createHttpServer(hub, auth, { maxBlobBytes: 1024 });
  await new Promise<void>((res) => server.listen(0, res));
  port = (server.address() as any).port;
  await api("POST", "/spaces", admin, { name: "kb" });
  await api("POST", "/spaces/kb/members", admin, { principalId: r.id, role: "viewer" });
});
afterAll(() => { server.close(); store.close(); });

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function upload(token: string, bytes: Uint8Array, type: string) {
  const res = await fetch(`http://localhost:${port}/v1/spaces/kb/blobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: bytes as any,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("blob store HTTP API", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 13, 10, 42]); // PNG-ish bytes incl. 0xFF/CRLF

  it("uploads binary, content-addresses, and downloads byte-exact", async () => {
    const up = await upload(admin, png, "image/png");
    expect(up.status).toBe(201);
    expect(up.body.hash).toMatch(/^b_/);
    expect(up.body.size).toBe(png.length);
    expect(up.body.url).toBe(`/v1/spaces/kb/blobs/${up.body.hash}`);

    const res = await fetch(`http://localhost:${port}${up.body.url}`, { headers: { authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("etag")).toBe(`"${up.body.hash}"`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...png]); // exact bytes
  });

  it("dedupes identical content to the same hash", async () => {
    const a = await upload(admin, png, "image/png");
    const b = await upload(admin, png, "image/png");
    expect(a.body.hash).toBe(b.body.hash); // content-addressed
  });

  it("a viewer can read but not upload (write-gated)", async () => {
    const up = await upload(reader, new Uint8Array([1, 2, 3]), "application/octet-stream");
    expect(up.status).toBe(403);
    // but can download an existing blob
    const existing = (await upload(admin, png, "image/png")).body.hash;
    const res = await fetch(`http://localhost:${port}/v1/spaces/kb/blobs/${existing}`, { headers: { authorization: `Bearer ${reader}` } });
    expect(res.status).toBe(200);
  });

  it("rejects an oversized upload with 413", async () => {
    const big = new Uint8Array(2048).fill(7); // > 1024 cap
    const up = await upload(admin, big, "application/octet-stream");
    expect(up.status).toBe(413);
  });

  it("404s an unknown blob", async () => {
    const res = await fetch(`http://localhost:${port}/v1/spaces/kb/blobs/b_nope`, { headers: { authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await fetch(`http://localhost:${port}/v1/spaces/kb/blobs`, { method: "POST", headers: { "content-type": "image/png" }, body: png as any });
    expect(res.status).toBe(401);
  });
});
