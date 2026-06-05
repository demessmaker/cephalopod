// HTTP Query/Command API (03 §2). Built on node:http with a tiny router; writes
// funnel through the same hub path as WS deltas, so HTTP and live editors
// converge. Every route is ACL-checked (05 §2).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Auth, can, type Action } from "./auth.js";
import type { SpaceHub } from "./hub.js";
import type { Principal, Role } from "./store/store.js";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  principal: Principal;
}
type Handler = (c: Ctx) => void;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    "^" + path.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
  );
  return { method, re, keys, handler };
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
};
const err = (res: ServerResponse, code: number, msg: string) => json(res, code, { error: msg });

export function createHttpServer(hub: SpaceHub, auth: Auth) {
  const routes: Route[] = [];
  const route = (m: string, p: string, h: Handler) => routes.push(compile(m, "/v1" + p, h));

  // require a space role >= action; sends 403 and returns false if not allowed
  const require = (c: Ctx, action: Action): boolean => {
    const role = auth.roleOf(c.params.space, c.principal.id);
    if (!can(role, action)) {
      err(c.res, 403, `forbidden: need ${action} on ${c.params.space}`);
      return false;
    }
    return true;
  };

  // --- principals & spaces ---
  route("POST", "/principals", (c) => {
    const kind = c.body?.kind === "agent" ? "agent" : "user";
    const p = auth.createPrincipal(kind, String(c.body?.name ?? kind));
    json(c.res, 201, { principal: p, token: auth.issueToken(p.id) });
  });

  route("GET", "/spaces", (c) => json(c.res, 200, { spaces: auth.memberships(c.principal.id) }));

  route("POST", "/spaces", (c) => {
    const name = String(c.body?.name ?? "").trim();
    if (!name) return err(c.res, 400, "name required");
    auth.setRole(name, c.principal.id, "admin"); // creator becomes admin
    json(c.res, 201, { space: name, role: "admin" });
  });

  route("POST", "/spaces/:space/members", (c) => {
    if (!require(c, "admin")) return;
    const { principalId, role } = c.body ?? {};
    if (!principalId || !["viewer", "editor", "admin"].includes(role)) return err(c.res, 400, "principalId + role required");
    auth.setRole(c.params.space, principalId, role as Role);
    json(c.res, 200, { ok: true });
  });

  // --- notes ---
  route("POST", "/spaces/:space/notes", (c) => {
    if (!require(c, "write")) return;
    const id = hub.createNote(c.params.space, c.body ?? {}, c.body?.id);
    json(c.res, 201, { id });
  });
  route("GET", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "read")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("PATCH", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "write")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    hub.patchNote(c.params.space, c.params.id, c.body ?? {});
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("DELETE", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "write")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    hub.deleteNote(c.params.space, c.params.id);
    json(c.res, 200, { ok: true });
  });

  // --- links & traversal ---
  route("POST", "/spaces/:space/links", (c) => {
    if (!require(c, "write")) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    hub.linkNote(c.params.space, from, to, type ?? null);
    json(c.res, 201, { ok: true });
  });
  route("POST", "/spaces/:space/unlink", (c) => {
    if (!require(c, "write")) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    hub.unlinkNote(c.params.space, from, to, type ?? null);
    json(c.res, 200, { ok: true });
  });
  route("GET", "/spaces/:space/notes/:id/neighbors", (c) => {
    if (!require(c, "read")) return;
    const hops = Number(c.url.searchParams.get("hops") ?? 1);
    const dir = (c.url.searchParams.get("dir") ?? "both") as "out" | "in" | "both";
    json(c.res, 200, hub.neighbors(c.params.space, c.params.id, hops, dir));
  });
  route("GET", "/spaces/:space/notes/:id/backlinks", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, hub.backlinks(c.params.space, c.params.id));
  });

  // --- search, tags, query ---
  route("GET", "/spaces/:space/search", (c) => {
    if (!require(c, "read")) return;
    const q = c.url.searchParams.get("q") ?? "";
    const limit = Number(c.url.searchParams.get("limit") ?? 20);
    json(c.res, 200, { hits: q ? hub.search(c.params.space, q, limit) : [] });
  });
  route("GET", "/spaces/:space/tags", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, { tags: hub.tagCounts(c.params.space) });
  });
  route("POST", "/spaces/:space/query", (c) => {
    if (!require(c, "read")) return;
    const m = c.body?.match ?? {};
    const tr = c.body?.traverse;
    if (tr?.from) return json(c.res, 200, hub.neighbors(c.params.space, tr.from, tr.hops ?? 1, tr.dir ?? "both"));
    if (m.text) return json(c.res, 200, { hits: hub.search(c.params.space, m.text, c.body?.limit ?? 20) });
    err(c.res, 400, "query needs match.text or traverse.from");
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const principal = auth.authenticate(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
    if (!principal) return err(res, 401, "unauthorized");

    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return err(res, 400, "invalid json");
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        try {
          return r.handler({ req, res, url, params, body, principal });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }
      err(res, 404, "no route");
    });
  });
  return server;
}
