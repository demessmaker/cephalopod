// Server hardening: /healthz, request body-size limit, WS token extraction.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { tokenFromUpgrade } from "../src/wsauth.js";

describe("tokenFromUpgrade", () => {
  it("prefers Authorization header, then subprotocol, then ?token=", () => {
    expect(tokenFromUpgrade({ headers: { authorization: "Bearer cph_h" }, url: "/?token=cph_q" })).toBe("cph_h");
    expect(tokenFromUpgrade({ headers: { "sec-websocket-protocol": "bearer, cph_p" }, url: "/" })).toBe("cph_p");
    expect(tokenFromUpgrade({ headers: {}, url: "/sync?token=cph_q" })).toBe("cph_q");
    expect(tokenFromUpgrade({ headers: {}, url: "/" })).toBeUndefined();
  });
});

let server: Server, store: SqliteStore, port: number, token: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  token = (await auth.bootstrapAdmin())!.token;
  server = createHttpServer(hub, auth, { maxBodyBytes: 1024 }); // 1 KiB cap for the test
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await fetch(`http://localhost:${port}/v1/spaces`, { method: "POST", headers: hdr(), body: JSON.stringify({ name: "kb" }) });
});
afterAll(() => server.close());

const hdr = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("hardening", () => {
  it("/healthz is unauthenticated and returns ok", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("rejects oversized request bodies with 413", async () => {
    const big = "x".repeat(5000);
    const res = await fetch(`http://localhost:${port}/v1/spaces/kb/notes`, {
      method: "POST",
      headers: hdr(),
      body: JSON.stringify({ title: "Big", body: big }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("payload_too_large");
  });

  it("still accepts normal-sized writes", async () => {
    const res = await fetch(`http://localhost:${port}/v1/spaces/kb/notes`, {
      method: "POST",
      headers: hdr(),
      body: JSON.stringify({ title: "Small", body: "ok" }),
    });
    expect(res.status).toBe(201);
  });
});
