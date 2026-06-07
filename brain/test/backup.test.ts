// Track E (ops): online SQLite backup/restore — a consistent snapshot reopens with
// all data intact, and a restore round-trips.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "bak-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {} });

describe("online backup / restore", () => {
  it("backs up a live DB to a consistent snapshot that reopens with all data", async () => {
    const dir = tmp();
    const live = join(dir, "brain.db");
    const store = new SqliteStore(live);
    const hub = new SpaceHub(store);
    await hub.createNote("kb", { title: "Billing", body: "charges customers" });
    await hub.putBlob("kb", new Uint8Array([1, 2, 3, 255]), "image/png");

    const snap = join(dir, "backup.db");
    await store.backup(snap); // online backup while the store is open
    store.close();
    expect(existsSync(snap)).toBe(true);

    // the snapshot is a complete, independent DB
    const restored = new SqliteStore(snap);
    const rhub = new SpaceHub(restored);
    expect((await rhub.search("kb", "charges")).some((n) => n.title === "Billing")).toBe(true);
    expect((await restored.blobBytes("kb"))).toBe(4); // blob came along
    restored.close();
  });

  it("restore round-trips (backup -> restore -> same data)", async () => {
    const dir = tmp();
    const src = new SqliteStore(join(dir, "src.db"));
    await new SpaceHub(src).createNote("kb", { title: "Note", body: "hello" });
    const backup = join(dir, "snap.db");
    await src.backup(backup);
    src.close();

    // "restore": copy the backup into a fresh live path via the same online API
    const target = join(dir, "live.db");
    const tmpStore = new SqliteStore(backup);
    await tmpStore.backup(target);
    tmpStore.close();

    const live = new SqliteStore(target);
    expect((await new SpaceHub(live).search("kb", "hello")).length).toBe(1);
    live.close();
  });
});
