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

  // per-space settings: agent write policy (05 §4) + required facets
  route("GET", "/spaces/:space/settings", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, { agentMode: hub.getAgentMode(c.params.space), requiredFacets: hub.getRequiredFacets(c.params.space) });
  });
  route("PUT", "/spaces/:space/settings", (c) => {
    if (!require(c, "admin")) return;
    const { agentMode, requiredFacets } = c.body ?? {};
    if (agentMode !== undefined) {
      if (agentMode !== "draft" && agentMode !== "open") return err(c.res, 400, "agentMode must be draft|open");
      hub.setAgentMode(c.params.space, agentMode);
    }
    if (requiredFacets !== undefined) {
      if (!Array.isArray(requiredFacets) || requiredFacets.some((f) => typeof f !== "string"))
        return err(c.res, 400, "requiredFacets must be a string[]");
      hub.setRequiredFacets(c.params.space, requiredFacets);
    }
    json(c.res, 200, { agentMode: hub.getAgentMode(c.params.space), requiredFacets: hub.getRequiredFacets(c.params.space) });
  });

  // Draft-gate (05 §4): agent writes are provenance-stamped and, when the space
  // is in "draft" mode, forced to #draft; agents may only touch their own drafts.
  const DRAFT = "draft";
  const gated = (c: Ctx) => c.principal.kind === "agent" && hub.getAgentMode(c.params.space) === "draft";
  const stamp = (kind: string) => (kind === "agent" ? "agent" : "human");

  // per-space required facets (e.g. client/project), with a #shared exemption
  const facetError = (c: Ctx, tags: string[]): boolean => {
    const miss = hub.missingFacets(c.params.space, tags);
    if (miss.length) {
      err(c.res, 422, `missing required facets: ${miss.join(", ")} — add tags like client:acme, or tag "shared" to exempt`);
      return true;
    }
    return false;
  };
  const tagFilters = (c: Ctx) => c.url.searchParams.getAll("tag");

  // --- notes ---
  route("POST", "/spaces/:space/notes", (c) => {
    if (!require(c, "write")) return;
    const fields = { ...(c.body ?? {}) };
    fields.props = { ...(fields.props ?? {}), authoredBy: stamp(c.principal.kind) };
    if (gated(c)) fields.tags = [...new Set([...(fields.tags ?? []), DRAFT])];
    if (facetError(c, fields.tags ?? [])) return;
    const id = hub.createNote(c.params.space, fields, c.body?.id);
    json(c.res, 201, { id, draft: gated(c) });
  });
  route("GET", "/spaces/:space/notes", (c) => {
    if (!require(c, "read")) return;
    const drafts = c.url.searchParams.get("drafts") === "1";
    json(c.res, 200, { notes: hub.listNotes(c.params.space, Number(c.url.searchParams.get("limit") ?? 50), drafts, tagFilters(c)) });
  });
  route("GET", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "read")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("PATCH", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "write")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    const patch = { ...(c.body ?? {}) };
    if (gated(c)) {
      const cur = hub.getNoteSnapshot(c.params.space, c.params.id);
      if (!cur.tags.includes(DRAFT)) return err(c.res, 403, "agents may only edit #draft notes");
      if (patch.tags && !patch.tags.includes(DRAFT)) patch.tags = [...patch.tags, DRAFT]; // can't self-promote
      patch.props = { ...(patch.props ?? {}), authoredBy: "agent" };
    }
    if (patch.tags !== undefined && facetError(c, patch.tags)) return; // enforce on explicit tag changes
    hub.patchNote(c.params.space, c.params.id, patch);
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("POST", "/spaces/:space/notes/:id/promote", (c) => {
    if (!require(c, "write")) return;
    if (c.principal.kind === "agent") return err(c.res, 403, "agents cannot promote drafts");
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    const cur = hub.getNoteSnapshot(c.params.space, c.params.id);
    hub.patchNote(c.params.space, c.params.id, { tags: cur.tags.filter((t) => t !== DRAFT) });
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
    const drafts = c.url.searchParams.get("drafts") === "1";
    const mode = (c.url.searchParams.get("mode") ?? "text") as "text" | "semantic" | "hybrid";
    json(c.res, 200, { hits: q ? hub.searchMode(c.params.space, q, mode, limit, drafts, tagFilters(c)) : [] });
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
    const limit = c.body?.limit ?? 20;
    const drafts = !!c.body?.includeDrafts;
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    if (m.semantic) return json(c.res, 200, { hits: hub.searchHybrid(c.params.space, m.semantic, limit, drafts, tags) });
    if (m.text) return json(c.res, 200, { hits: hub.search(c.params.space, m.text, limit, drafts, tags) });
    err(c.res, 400, "query needs match.text, match.semantic, or traverse.from");
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
