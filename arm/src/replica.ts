// A developer's local arm: a persistent CRDT replica of a cached subgraph that
// syncs deltas with the brain. Edits apply locally (offline-capable) and
// reconcile on (re)connect via the standard state-vector handshake.
import * as Y from "yjs";
import { WebSocket } from "ws";
import { handle, getTitle, type NoteHandle } from "./core/note.js";
import { newNoteId, edgeId } from "./core/ids.js";
import { b64, type ClientMsg, type ServerMsg, type NodeSummary } from "./core/protocol.js";
import { FileStore } from "./persistence.js";

const REMOTE = "remote"; // Yjs origin for applied remote updates

export interface ReplicaOptions {
  wsUrl: string;
  httpUrl: string;
  token: string;
  space: string;
  cacheDir: string;
}

export class Replica {
  private docs = new Map<string, Y.Doc>();
  private working = new Set<string>();
  private dirty = new Set<string>(); // notes with local-only (unsynced) edits
  private store: FileStore;
  private ws?: WebSocket;
  private lastMsgAt = 0;
  connected = false;

  constructor(private o: ReplicaOptions) {
    this.store = new FileStore(o.cacheDir, o.space);
  }

  // Load the cached working set from disk (offline start).
  load(): void {
    for (const id of new Set([...this.store.loadManifest(), ...this.store.cachedIds()])) {
      const doc = this.ensureDoc(id);
      const state = this.store.loadDoc(id);
      if (state) Y.applyUpdate(doc, state, REMOTE);
      this.working.add(id);
    }
  }

  private ensureDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (doc) return doc;
    doc = new Y.Doc();
    this.docs.set(id, doc);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.store.saveDoc(id, Y.encodeStateAsUpdate(doc!)); // persist every change
      if (origin === REMOTE) return;
      if (this.connected) this.send({ t: "update", space: this.o.space, note: id, update: b64.enc(update) });
      else this.dirty.add(id); // offline: remember to push on reconnect
    });
    return doc;
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === this.ws?.OPEN) this.ws?.send(JSON.stringify(msg));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // token via Authorization header (not the URL) so it doesn't leak into logs
      const ws = new WebSocket(this.o.wsUrl, { headers: { authorization: `Bearer ${this.o.token}` } });
      ws.on("open", () => {
        this.ws = ws;
        this.connected = true;
        for (const id of this.working) this.openAndSync(id); // reconcile all cached docs
        resolve();
      });
      // A drop AFTER connect must flip `connected` so subsequent edits fall through
      // to the offline `dirty` path instead of being silently swallowed by send().
      // (reject() is a no-op once the open promise has already resolved.)
      ws.on("close", () => {
        if (this.ws === ws) this.ws = undefined;
        this.connected = false;
      });
      ws.on("error", (err) => {
        this.connected = false;
        reject(err);
      });
      ws.on("message", (data) => {
        this.lastMsgAt = Date.now();
        try {
          this.onMessage(JSON.parse(data.toString()) as ServerMsg);
        } catch {
          /* ignore */
        }
      });
    });
  }

  disconnect(): void {
    this.connected = false;
    this.ws?.close();
    this.ws = undefined;
  }

  private openAndSync(id: string): void {
    const doc = this.ensureDoc(id);
    this.send({ t: "open", space: this.o.space, note: id });
    this.send({ t: "sync1", space: this.o.space, note: id, sv: b64.enc(Y.encodeStateVector(doc)) });
  }

  private onMessage(msg: ServerMsg): void {
    // the arm only cares about per-note sync frames (it never subscribes)
    if (msg.t !== "sync1" && msg.t !== "sync2" && msg.t !== "update") return;
    const doc = this.ensureDoc(msg.note);
    switch (msg.t) {
      case "sync2":
      case "update":
        Y.applyUpdate(doc, b64.dec(msg.update), REMOTE);
        break;
      case "sync1": {
        // server wants our state -> send our diff; this pushes any offline edits
        this.send({ t: "sync2", space: this.o.space, note: msg.note, update: b64.enc(Y.encodeStateAsUpdate(doc, b64.dec(msg.sv))) });
        this.dirty.delete(msg.note); // server now has our changes
        break;
      }
    }
  }

  // Resolve a scope on the brain (HTTP) and cache the resulting notes.
  async pullScope(focus: string, hops = 1): Promise<string[]> {
    const r = await this.http(`/notes/${encodeURIComponent(focus)}/neighbors?hops=${hops}`);
    const ids: string[] = [focus, ...r.nodes.map((n: NodeSummary) => n.id)];
    for (const id of ids) this.openNote(id);
    this.persistManifest();
    return [...new Set(ids)];
  }

  openNote(id: string): void {
    this.working.add(id);
    this.ensureDoc(id);
    if (this.connected) this.openAndSync(id);
    this.persistManifest();
  }

  newNote(fields: { title?: string; body?: string; tags?: string[] }, id = newNoteId()): string {
    const doc = this.ensureDoc(id);
    this.working.add(id);
    doc.transact(() => {
      const h = handle(id, doc);
      h.meta.set("createdAt", new Date().toISOString());
      if (fields.title !== undefined) h.meta.set("title", fields.title);
      if (fields.body) h.body.insert(0, fields.body);
      if (fields.tags) for (const t of fields.tags) h.tags.push([t]);
    });
    if (this.connected) this.openAndSync(id);
    this.persistManifest();
    return id;
  }

  setTitle(id: string, title: string): void {
    handle(id, this.ensureDoc(id)).meta.set("title", title);
  }
  appendBody(id: string, text: string): void {
    const b = handle(id, this.ensureDoc(id)).body;
    b.insert(b.length, text);
  }
  link(id: string, to: string, type: string | null = null): void {
    handle(id, this.ensureDoc(id)).outLinks.set(edgeId(id, to, type), { to, type });
  }

  getNote(id: string): { id: string; title: string; body: string; tags: string[]; outLinks: { to: string; type: string | null }[] } | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    const h: NoteHandle = handle(id, doc);
    return {
      id,
      title: getTitle(h),
      body: h.body.toString(),
      tags: h.tags.toArray(),
      outLinks: [...h.outLinks.values()].map((v) => ({ to: v.to, type: v.type ?? null })),
    };
  }

  workingSet(): string[] {
    return [...this.working];
  }
  status() {
    return { connected: this.connected, cached: this.working.size, dirty: [...this.dirty] };
  }

  // Resolve once the sync stream has been quiet for `quietMs` (handshake settled).
  waitIdle(quietMs = 150, maxMs = 3000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const idle = Date.now() - this.lastMsgAt;
        if ((this.lastMsgAt && idle >= quietMs) || Date.now() - start >= maxMs) resolve();
        else setTimeout(tick, 30);
      };
      this.lastMsgAt = this.lastMsgAt || Date.now();
      setTimeout(tick, quietMs);
    });
  }

  private persistManifest(): void {
    this.store.saveManifest([...this.working]);
  }

  private async http(path: string): Promise<any> {
    const res = await fetch(`${this.o.httpUrl}/v1/spaces/${encodeURIComponent(this.o.space)}${path}`, {
      headers: { authorization: `Bearer ${this.o.token}` },
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
    return res.json();
  }
  async search(q: string): Promise<NodeSummary[]> {
    return (await this.http(`/search?q=${encodeURIComponent(q)}`)).hits;
  }
}
