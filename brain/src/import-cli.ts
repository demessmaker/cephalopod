// CLI: import an Obsidian vault into a space (08 §6).
//   npm run import -- <vault-path> --space <id> [--db <file>] [--dry-run]
//   [--update skip|merge|overwrite] [--no-write-back] [--keep-titles]
//   [--attachments link|skip] [--exclude <fragment>]...
import { SqliteStore } from "./store/sqlite.js";
import { SpaceHub } from "./hub.js";
import { importVault, type ImportOptions } from "./import/obsidian.js";

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opt.dryRun = true;
    else if (a === "--no-write-back") opt.writeBack = false;
    else if (a === "--keep-titles") opt.keepTitles = true;
    else if (a === "--exclude") (opt.exclude ??= [] as string[]), (opt.exclude as string[]).push(argv[++i]);
    else if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

const { pos, opt } = parseArgs(process.argv.slice(2));
const vault = pos[0];
const space = opt.space as string;
if (!vault || !space) {
  console.error("usage: import <vault-path> --space <id> [--db <file>] [--dry-run] …");
  process.exit(1);
}

const store = new SqliteStore((opt.db as string) ?? "./brain.db");
const hub = new SpaceHub(store);
const options: ImportOptions = {
  dryRun: !!opt.dryRun,
  writeBack: opt.writeBack !== false,
  keepTitles: !!opt.keepTitles,
  update: (opt.update as ImportOptions["update"]) ?? "merge",
  attachments: (opt.attachments as ImportOptions["attachments"]) ?? "link",
  exclude: (opt.exclude as string[]) ?? [],
};

const r = importVault(hub, space, vault, options);
hub.snapshotAll();
store.close();

console.log(`Imported into space "${space}"${options.dryRun ? " (dry run)" : ""}:`);
console.log(`  notes:        ${r.notesCreated} created, ${r.notesUpdated} updated, ${r.notesSkipped} unchanged`);
console.log(`  edges:        ${r.wikilinkEdges} wikilink, ${r.embedEdges} embeds`);
console.log(`  stubs:        ${r.stubs} unresolved links`);
console.log(`  attachments:  ${r.attachments}`);
console.log(`  warnings:     ${r.warnings.length}`);
for (const w of r.warnings.slice(0, 10)) console.log(`    - ${w}`);
console.log(`  duration:     ${r.durationMs} ms`);
