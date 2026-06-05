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

  search(query: string, limit = 20): Promise<{ hits: NodeSummary[] }> {
    return this.req("GET", this.s(`/search?q=${encodeURIComponent(query)}&limit=${limit}`));
  }
  getNote(id: string): Promise<NoteSnapshot> {
    return this.req("GET", this.s(`/notes/${encodeURIComponent(id)}`));
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

  // Accept a note id OR a title (03 §4 ergonomics). Returns the resolved id, or
  // undefined if a title matches nothing.
  async resolveRef(ref: string): Promise<string | undefined> {
    if (ref.startsWith("n_")) return ref;
    const { hits } = await this.search(ref, 5);
    const exact = hits.find((h) => h.title.toLowerCase() === ref.toLowerCase());
    return (exact ?? hits[0])?.id;
  }
}
