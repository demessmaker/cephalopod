// N4: per-token rate limiting + per-space note quota.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter (token bucket)", () => {
  it("allows up to capacity, then refuses, then refills over time", () => {
    const rl = new RateLimiter(2, 1); // burst 2, 1/sec
    const t0 = 1_000_000;
    expect(rl.allow("k", t0)).toBe(true);
    expect(rl.allow("k", t0)).toBe(true);
    expect(rl.allow("k", t0)).toBe(false); // exhausted
    expect(rl.allow("k", t0 + 1100)).toBe(true); // ~1 token refilled
    expect(rl.allow("other", t0)).toBe(true); // independent key
  });
});

let store: SqliteStore, auth: Auth, hub: SpaceHub, adminToken: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  auth = new Auth(store);
  hub = new SpaceHub(store);
  adminToken = (await auth.bootstrapAdmin())!.token;
});
afterAll(() => store.close());

async function call(server: Server, method: string, path: string, body?: unknown) {
  const port = (server.address() as any).port;
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("N4 — HTTP rate limiting", () => {
  it("returns 429 rate_limited once the per-token bucket is empty", async () => {
    const server = createHttpServer(hub, auth, { rateLimit: { capacity: 2, refillPerSec: 0 } });
    await new Promise<void>((r) => server.listen(0, r));
    expect((await call(server, "GET", "/spaces")).status).toBe(200);
    expect((await call(server, "GET", "/spaces")).status).toBe(200);
    const limited = await call(server, "GET", "/spaces");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    server.close();
  });
});

describe("N4 — per-space note quota", () => {
  it("blocks creates beyond maxNotes with 429 quota_exceeded", async () => {
    const server = createHttpServer(hub, auth); // no rate limit here
    await new Promise<void>((r) => server.listen(0, r));
    await call(server, "POST", "/spaces", { name: "quota" });
    await call(server, "PUT", "/spaces/quota/settings", { maxNotes: 2 });

    expect((await call(server, "POST", "/spaces/quota/notes", { title: "n1" })).status).toBe(201);
    expect((await call(server, "POST", "/spaces/quota/notes", { title: "n2" })).status).toBe(201);
    const over = await call(server, "POST", "/spaces/quota/notes", { title: "n3" });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("quota_exceeded");

    // raising the quota lets it through; settings echo the value
    const s = await call(server, "PUT", "/spaces/quota/settings", { maxNotes: 10 });
    expect(s.body.maxNotes).toBe(10);
    expect((await call(server, "POST", "/spaces/quota/notes", { title: "n3" })).status).toBe(201);
    server.close();
  });
});
