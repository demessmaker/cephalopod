// CLI: online backup / restore of the brain's SQLite database (Track E, ops).
//   npm run backup  -- <dest.db>  [--db <source.db>]   (safe against a LIVE brain)
//   npm run restore -- <source.db> [--db <dest.db>]    (STOP the brain first)
// Both use SQLite's online-backup API (WAL-aware, consistent), not a raw file copy.
// `restore` opens the source first, which validates it's a real DB (runs migrations).
import { statSync } from "node:fs";
import { SqliteStore } from "./store/sqlite.js";

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

const argv = process.argv.slice(2);
const mode = process.env.CEPH_BACKUP_MODE ?? (argv[0] === "backup" || argv[0] === "restore" ? argv.shift()! : "backup");
const { pos, opt } = parseArgs(argv);
const liveDb = opt.db ?? process.env.CEPH_DB ?? "./brain.db";

if (!pos[0]) {
  console.error(`usage: ${mode} <${mode === "backup" ? "dest" : "source"}.db> [--db <${mode === "backup" ? "source" : "dest"}.db>]`);
  process.exit(1);
}

// backup: live DB -> dest ;  restore: source -> live DB
const [src, dest] = mode === "backup" ? [liveDb, pos[0]] : [pos[0], liveDb];
const store = new SqliteStore(src); // opens (and migrates) the source
await store.backup(dest); // ESM top-level await
store.close();
const size = statSync(dest).size;
console.log(`${mode === "backup" ? "Backed up" : "Restored"} ${src} -> ${dest} (${(size / 1024).toFixed(1)} KiB)`);
if (mode === "restore") console.log("Restart the brain to pick up the restored database.");
