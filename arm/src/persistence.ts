// On-disk cache for an arm's working set (the offline copy). Each cached note is
// stored as its full CRDT state; a manifest records which notes are in the set.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class FileStore {
  private dir: string;
  constructor(cacheDir: string, space: string) {
    this.dir = join(cacheDir, space);
    mkdirSync(this.dir, { recursive: true });
  }

  loadManifest(): string[] {
    const p = join(this.dir, "manifest.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).notes ?? []) : [];
  }
  saveManifest(notes: string[]): void {
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify({ notes, updatedAt: Date.now() }, null, 2));
  }

  loadDoc(id: string): Uint8Array | undefined {
    const p = join(this.dir, `${id}.ydoc`);
    if (!existsSync(p)) return undefined;
    const b = readFileSync(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  saveDoc(id: string, state: Uint8Array): void {
    writeFileSync(join(this.dir, `${id}.ydoc`), Buffer.from(state));
  }

  cachedIds(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".ydoc")).map((f) => f.slice(0, -5));
  }
}
