// The editor's live replica. A VS Code window holds one EditorSession per space:
// an in-memory set of per-note Y.Docs that sync deltas with the brain over the
// same WebSocket handshake the CLI arm uses, but tuned for an editor instead of a
// CLI. The body of each note is a Y.Text; an editor save hands us the whole new
// document and we map it to the smallest CRDT edit (see diff.ts) so concurrent
// collaborators converge. Remote updates fire onRemoteChange so the editor can
// reload the affected buffer.
//
// This module deliberately imports NO vscode API — it is the pure, headlessly
// testable half of the extension (see test/session.test.ts). The vscode glue
// (FileSystemProvider, commands, tree, status bar) lives in extension.ts.
import * as Y from "yjs";
import { WebSocket } from "ws";
import { handle, getTitle, type NoteHandle, type OutLink } from "./core/note.js";
import { newNoteId, edgeId } from "./core/ids.js";
import { b64, type ClientMsg, type ServerMsg, type NodeSummary } from "./core/protocol.js";
import { applyTextChange } from "./diff.js";

const REMOTE = "remote"; // Yjs origin for applied remote updates
const LOCAL = "local"; // Yjs origin for our own (editor) edits

export interface SessionOptions {
  wsUrl: string;
  httpUrl: string;
  token: string;
  space: string;
}

export interface NoteSnapshot {
  id: string;
  title: string;
  body: string;
  tags: string[];
  outLinks: { to: string; type: string | null }[];
}

export class EditorSession {
  private docs = new Map<string, Y.Doc>();
  private working = new Set<string>(); // notes currently open/cached in this session
  private dirty = new Set<string>(); // notes with local-only (unsynced) edits
  private ws?: WebSocket;
  private lastMsgAt = 0;
  connected = false;

  // The editor subscribes here: `id` is the note whose CRDT body just changed
  // because a *remote* delta landed, so an open buffer should be refreshed. Local
  // edits (our own setBody) never fire this — the buffer is already current.
  onRemoteChange?: (id: string) => void;
  // Fires for ANY change (local or remote) to a working-set note, plus
  // open/connect transitions — for refreshing a tree view / status bar.
  onModelChange?: () => void;

  constructor(private o: SessionOptions) {}

  private ensureDoc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (doc) return doc;
    doc = new Y.Doc();
    this.docs.set(id, doc);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) {
        this.onRemoteChange?.(id);
        this.onModelChange?.();
        return;
      }
      // a local edit: push it now, or queue it for the next reconnect
      if (this.connected) this.send({ t: "update", space: this.o.space, note: id, update: b64.enc(update) });
      else this.dirty.add(id);
      this.onModelChange?.();
    });
    return doc;
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // token via Authorization header (not the URL) so it doesn't leak into logs
      const ws = new WebSocket(this.o.wsUrl, { headers: { authorization: `Bearer ${this.o.token}` } });
      ws.on("open", () => {
        this.ws = ws;
        this.connected = true;
        for (const id of this.working) this.openAndSync(id); // reconcile every open note
        this.onModelChange?.();
        resolve();
      });
      // A drop AFTER connect must flip `connected` so later edits fall through to the
      // offline `dirty` queue instead of being swallowed by send(). reject() is a
      // no-op once the open promise has resolved.
      ws.on("close", () => {
        if (this.ws === ws) this.ws = undefined;
        this.connected = false;
        this.onModelChange?.();
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
          /* ignore malformed frames */
        }
      });
    });
  }

  disconnect(): void {
    this.connected = false;
    this.ws?.close();
    this.ws = undefined;
    this.onModelChange?.();
  }

  private openAndSync(id: string): void {
    const doc = this.ensureDoc(id);
    this.send({ t: "open", space: this.o.space, note: id });
    this.send({ t: "sync1", space: this.o.space, note: id, sv: b64.enc(Y.encodeStateVector(doc)) });
  }

  private onMessage(msg: ServerMsg): void {
    if (msg.t !== "sync1" && msg.t !== "sync2" && msg.t !== "update") return;
    const doc = this.ensureDoc(msg.note);
    switch (msg.t) {
      case "sync2":
      case "update":
        Y.applyUpdate(doc, b64.dec(msg.update), REMOTE);
        break;
      case "sync1": {
        // server wants our state -> send our diff; this pushes any queued edits
        this.send({ t: "sync2", space: this.o.space, note: msg.note, update: b64.enc(Y.encodeStateAsUpdate(doc, b64.dec(msg.sv))) });
        this.dirty.delete(msg.note); // server now has our changes
        break;
      }
    }
  }

  // --- working set ---------------------------------------------------------

  openNote(id: string): void {
    const isNew = !this.working.has(id);
    this.working.add(id);
    this.ensureDoc(id);
    if (this.connected) this.openAndSync(id);
    if (isNew) this.onModelChange?.();
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
    }, LOCAL);
    if (this.connected) this.openAndSync(id);
    return id;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }
  workingSet(): string[] {
    return [...this.working];
  }
  status() {
    return { connected: this.connected, open: this.working.size, dirty: [...this.dirty] };
  }

  // --- reads ---------------------------------------------------------------

  bodyText(id: string): string {
    const doc = this.docs.get(id);
    return doc ? handle(id, doc).body.toString() : "";
  }
  title(id: string): string {
    const doc = this.docs.get(id);
    return doc ? getTitle(handle(id, doc)) : "";
  }
  tags(id: string): string[] {
    const doc = this.docs.get(id);
    return doc ? handle(id, doc).tags.toArray() : [];
  }
  getNote(id: string): NoteSnapshot | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    const h: NoteHandle = handle(id, doc);
    return {
      id,
      title: getTitle(h),
      body: h.body.toString(),
      tags: h.tags.toArray(),
      outLinks: [...h.outLinks.values()].map((v: OutLink) => ({ to: v.to, type: v.type ?? null })),
    };
  }

  // --- writes (editor save paths) -----------------------------------------

  // The editor hands us the whole buffer; map it to the smallest Y.Text edit.
  setBody(id: string, text: string): void {
    applyTextChange(handle(id, this.ensureDoc(id)).body, text, LOCAL);
  }
  setTitle(id: string, title: string): void {
    handle(id, this.ensureDoc(id)).meta.set("title", title); // LWW
  }
  setTags(id: string, tags: string[]): void {
    const h = handle(id, this.ensureDoc(id));
    h.doc.transact(() => {
      if (h.tags.length) h.tags.delete(0, h.tags.length);
      for (const t of tags) h.tags.push([t]);
    }, LOCAL);
  }
  link(id: string, to: string, type: string | null = null): void {
    handle(id, this.ensureDoc(id)).outLinks.set(edgeId(id, to, type), { to, type });
  }

  // --- brain HTTP (scope + search) ----------------------------------------

  async pullScope(focus: string, hops = 1): Promise<string[]> {
    const r = await this.http(`/notes/${encodeURIComponent(focus)}/neighbors?hops=${hops}`);
    const ids: string[] = [focus, ...r.nodes.map((n: NodeSummary) => n.id)];
    for (const id of ids) this.openNote(id);
    return [...new Set(ids)];
  }
  async search(q: string): Promise<NodeSummary[]> {
    return (await this.http(`/search?q=${encodeURIComponent(q)}`)).hits;
  }

  private async http(path: string): Promise<any> {
    const res = await fetch(`${this.o.httpUrl}/v1/spaces/${encodeURIComponent(this.o.space)}${path}`, {
      headers: { authorization: `Bearer ${this.o.token}` },
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
    return res.json();
  }

  // Resolve once the sync stream has been quiet for `quietMs` (handshake settled).
  // Used by tests and by commands that need a fresh pull to land before reading.
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
}
