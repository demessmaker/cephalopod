// Thin client over the brain's HTTP API (03 §4: the MCP server wraps the API).
// Configured for a single space + an agent token.

export interface NoteSnapshot {
  id: string;
  title: string;
  body: string;
  tags: string[];
  props: Record<string, unknown>;
  outLinks: { to: string; type: string | null }[];
  deleted: boolean;
}
export interface NodeSummary { id: string; title: string; tags: string[]; stub: boolean }
export interface EdgeRec { from: string; to: string; type: string | null; origin: string }
export interface Subgraph { nodes: NodeSummary[]; edges: EdgeRec[] }
export interface ContextItem {
  id: string; title: string; tags: string[]; stub: boolean; body: string;
  relevance: "match" | "linked"; truncated?: boolean;
  provenance: { authoredBy: string; draft: boolean; lastEditedBy?: string; lastEditedAt?: number };
}
export interface ContextPack {
  query: string; items: ContextItem[]; edges: EdgeRec[];
  tokenBudget: number; usedTokens: number; truncated: boolean;
}

export class CephalopodClient {
  constructor(
    private baseUrl: string,
    private token: string,
    public space: string,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status}: ${json?.error ?? res.statusText}`);
    return json;
  }
  private s(path: string) {
    return `/spaces/${encodeURIComponent(this.space)}${path}`;
  }

  search(query: string, limit = 20, mode: "text" | "semantic" | "hybrid" = "text", tags: string[] = []): Promise<{ hits: NodeSummary[] }> {
    const tagQs = tags.map((t) => `&tag=${encodeURIComponent(t)}`).join("");
    return this.req("GET", this.s(`/search?q=${encodeURIComponent(query)}&limit=${limit}&mode=${mode}${tagQs}`));
  }
  getNote(id: string): Promise<NoteSnapshot> {
    return this.req("GET", this.s(`/notes/${encodeURIComponent(id)}`));
  }
  getContext(query: string, opts: { tokenBudget?: number; mode?: string; hops?: number; tags?: string[]; drafts?: boolean } = {}): Promise<ContextPack> {
    return this.req("POST", this.s(`/context`), { query, ...opts });
  }
  createNote(fields: { title?: string; body?: string; tags?: string[]; props?: Record<string, unknown> }): Promise<{ id: string }> {
    return this.req("POST", this.s(`/notes`), fields);
  }
  updateNote(id: string, patch: object): Promise<NoteSnapshot> {
    return this.req("PATCH", this.s(`/notes/${encodeURIComponent(id)}`), patch);
  }
  link(from: string, to: string, type: string | null): Promise<unknown> {
    return this.req("POST", this.s(`/links`), { from, to, type });
  }
  unlink(from: string, to: string, type: string | null): Promise<unknown> {
    return this.req("POST", this.s(`/unlink`), { from, to, type });
  }
  neighbors(id: string, hops = 1, dir = "both"): Promise<Subgraph> {
    return this.req("GET", this.s(`/notes/${encodeURIComponent(id)}/neighbors?hops=${hops}&dir=${dir}`));
  }
  backlinks(id: string): Promise<Subgraph> {
    return this.req("GET", this.s(`/notes/${encodeURIComponent(id)}/backlinks`));
  }
  tags(): Promise<{ tags: { tag: string; count: number }[] }> {
    return this.req("GET", this.s(`/tags`));
  }
  listSpaces(): Promise<{ spaces: { space: string; role: string }[] }> {
    return this.req("GET", `/spaces`);
  }
  listNotes(limit = 50): Promise<{ notes: NodeSummary[] }> {
    return this.req("GET", this.s(`/notes?limit=${limit}`));
  }

  // Accept a note id OR a title (03 §4 ergonomics). Returns the resolved id, or
  // undefined if nothing matches. With `exact`, only an id or an exact-title match
  // resolves — mutations pass this so a fuzzy top-hit can't silently target (and
  // edit) the wrong note. Reads may fall back to the best search hit.
  async resolveRef(ref: string, exact = false): Promise<string | undefined> {
    if (ref.startsWith("n_")) return ref;
    const { hits } = await this.search(ref, 5);
    const match = hits.find((h) => h.title.toLowerCase() === ref.toLowerCase());
    if (match) return match.id;
    return exact ? undefined : hits[0]?.id;
  }
}
