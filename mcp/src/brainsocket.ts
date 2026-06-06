// A thin WebSocket client to the brain's sync relay, used only to learn *when*
// notes change so the MCP server can emit live resource-update notifications
// (03 §4.3). It opens notes to receive the brain's fan-out; it does not apply
// CRDT state (the agent re-reads via HTTP on notification).
import { WebSocket } from "ws";

export class BrainSocket {
  private ws?: WebSocket;
  private handler?: (space: string, note: string) => void;
  private opened = new Set<string>(); // notes the brain is currently fanning out to us
  private desired = new Set<string>(); // notes we want open (re-sent on (re)connect)

  constructor(private wsUrl: string, private token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`);
      ws.on("open", () => {
        this.ws = ws;
        this.opened.clear();
        for (const key of this.desired) this.sendOpen(key); // (re)subscribe everything we still want
        resolve();
      });
      ws.on("error", reject);
      ws.on("message", (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.t === "update") this.handler?.(m.space, m.note);
        } catch {
          /* ignore */
        }
      });
    });
  }

  open(space: string, note: string): void {
    this.desired.add(`${space} ${note}`);
    this.sendOpen(`${space} ${note}`);
  }

  // Stop watching a note. The wire protocol has no "close note", so the brain
  // keeps fanning out until the socket closes; dropping it from our sets stops us
  // re-opening it and bounds memory (the MCP layer also filters by `watched`).
  unopen(space: string, note: string): void {
    const key = `${space} ${note}`;
    this.desired.delete(key);
    this.opened.delete(key);
  }

  // Send `open` only when actually connected, and only record it as opened once
  // the send succeeds — otherwise a send dropped mid-handshake would be marked
  // opened and never retried. Unsent opens are (re)sent from the connect handler.
  private sendOpen(key: string): void {
    if (this.opened.has(key)) return;
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    const [space, note] = key.split(" ");
    this.ws.send(JSON.stringify({ t: "open", space, note }));
    this.opened.add(key);
  }

  onUpdate(handler: (space: string, note: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.ws?.close();
  }
}
