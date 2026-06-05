// A thin WebSocket client to the brain's sync relay, used only to learn *when*
// notes change so the MCP server can emit live resource-update notifications
// (03 §4.3). It opens notes to receive the brain's fan-out; it does not apply
// CRDT state (the agent re-reads via HTTP on notification).
import { WebSocket } from "ws";

export class BrainSocket {
  private ws?: WebSocket;
  private handler?: (space: string, note: string) => void;
  private opened = new Set<string>();

  constructor(private wsUrl: string, private token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`);
      ws.on("open", () => {
        this.ws = ws;
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
    const key = `${space} ${note}`;
    if (this.opened.has(key)) return;
    this.opened.add(key);
    this.ws?.send(JSON.stringify({ t: "open", space, note }));
  }

  onUpdate(handler: (space: string, note: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.ws?.close();
  }
}
