// CLI: export a space to an Obsidian vault, or bidirectionally sync the two.
//   npm run export -- <vault-path> --space <id> [--db <file>] [--drafts] [--dry-run]
//   npm run sync   -- <vault-path> --space <id> [--db <file>] [--conflict brain|vault]
//                     [--no-write-back] [--drafts] [--dry-run] [--exclude <fragment>]...
// The leading mode word is implied by the npm script (export|sync); pass it explicitly
// when running the file directly: tsx src/sync-cli.ts <export|sync> <vault> --space ...
import { SqliteStore } from "./store/sqlite.js";
import { SpaceHub } from "./hub.js";
import { exportVault, type ExportOptions } from "./import/export.js";
import { syncVault, type SyncOptions } from "./import/sync.js";

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opt.dryRun = true;
    else if (a === "--drafts") opt.includeDrafts = true;
    else if (a === "--keep-ids") opt.keepIds = true;
    else if (a === "--no-write-back") opt.writeBack = false;
    else if (a === "--exclude") (opt.exclude ??= [] as string[]), (opt.exclude as string[]).push(argv[++i]);
    else if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

const argv = process.argv.slice(2);
const mode = process.env.CEPH_SYNC_MODE ?? (argv[0] === "export" || argv[0] === "sync" ? argv.shift()! : "sync");
const { pos, opt } = parseArgs(argv);
const vault = pos[0];
const space = opt.space as string;
if (!vault || !space) {
  console.error(`usage: ${mode} <vault-path> --space <id> [--db <file>] [--drafts] [--dry-run] …`);
  process.exit(1);
}

const store = new SqliteStore((opt.db as string) ?? "./brain.db");
const hub = new SpaceHub(store);

if (mode === "export") {
  const options: ExportOptions = { dryRun: !!opt.dryRun, includeDrafts: !!opt.includeDrafts, keepIds: !!opt.keepIds };
  const r = await exportVault(hub, space, vault, options);
  await hub.snapshotAll();
  store.close();
  console.log(`Exported space "${space}" -> ${vault}${options.dryRun ? " (dry run)" : ""}:`);
  console.log(`  files:    ${r.filesWritten} written, ${r.filesUnchanged} unchanged`);
  console.log(`  warnings: ${r.warnings.length}`);
  for (const w of r.warnings.slice(0, 10)) console.log(`    - ${w}`);
  console.log(`  duration: ${r.durationMs} ms`);
} else {
  const options: SyncOptions = {
    dryRun: !!opt.dryRun,
    includeDrafts: !!opt.includeDrafts,
    keepIds: !!opt.keepIds,
    writeBack: opt.writeBack !== false,
    conflict: (opt.conflict as SyncOptions["conflict"]) ?? "brain",
    exclude: (opt.exclude as string[]) ?? [],
  };
  const r = await syncVault(hub, space, vault, options);
  await hub.snapshotAll();
  store.close();
  console.log(`Synced space "${space}" <-> ${vault}${options.dryRun ? " (dry run)" : ""}:`);
  console.log(`  imported:  ${r.imported} (vault -> brain)`);
  console.log(`  exported:  ${r.exported} (brain -> vault)`);
  console.log(`  conflicts: ${r.conflicts.length}${r.conflicts.length ? ` (resolved: ${options.conflict} wins)` : ""}`);
  console.log(`  unchanged: ${r.unchanged}`);
  console.log(`  warnings:  ${r.warnings.length}`);
  for (const w of r.warnings.slice(0, 10)) console.log(`    - ${w}`);
  console.log(`  duration:  ${r.durationMs} ms`);
}
