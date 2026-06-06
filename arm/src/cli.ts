// CLI arm (08-style developer tool). Config via env:
//   CEPH_WS_URL (ws://localhost:7700) CEPH_HTTP_URL (http://localhost:7701)
//   CEPH_TOKEN CEPH_SPACE CEPH_CACHE (./.cache)
// Commands: ls | cat <id> | new <title> [body] | title <id> <t> | append <id> <t>
//           | link <id> <to> [type] | pull <id> [hops] | search <q> | status | sync
import { Replica } from "./replica.js";

function cfg() {
  const space = process.env.CEPH_SPACE;
  const token = process.env.CEPH_TOKEN;
  if (!space || !token) {
    console.error("CEPH_SPACE and CEPH_TOKEN are required");
    process.exit(1);
  }
  return new Replica({
    wsUrl: process.env.CEPH_WS_URL ?? "ws://localhost:7700",
    httpUrl: process.env.CEPH_HTTP_URL ?? "http://localhost:7701",
    token,
    space,
    cacheDir: process.env.CEPH_CACHE ?? "./.cache",
  });
}

async function tryConnect(r: Replica): Promise<boolean> {
  try {
    await r.connect();
    return true;
  } catch {
    console.error("(offline — edits are cached locally and will sync later)");
    return false;
  }
}

function need(args: string[], n: number, usage: string): void {
  if (args.length < n || args.slice(0, n).some((a) => a === undefined || a === "")) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const r = cfg();
  r.load();

  switch (cmd) {
    case "ls": {
      for (const id of r.workingSet()) {
        const n = r.getNote(id);
        console.log(`${id}  ${n?.title ?? ""}`);
      }
      break;
    }
    case "cat": {
      need(args, 1, "cat <id>");
      const n = r.getNote(args[0]);
      if (!n) return console.error("not cached:", args[0]);
      console.log(`# ${n.title}\n\n${n.body}`);
      break;
    }
    case "new": {
      need(args, 1, "new <title> [body]");
      const online = await tryConnect(r);
      const id = r.newNote({ title: args[0], body: args[1] });
      if (online) await r.waitIdle();
      console.log(id);
      break;
    }
    case "title":
    case "append":
    case "link": {
      if (cmd === "link") need(args, 2, "link <id> <to> [type]");
      else need(args, 2, `${cmd} <id> <text>`);
      const online = await tryConnect(r);
      if (cmd === "title") r.setTitle(args[0], args[1]);
      else if (cmd === "append") r.appendBody(args[0], args[1]);
      else r.link(args[0], args[1], args[2] ?? null);
      if (online) await r.waitIdle();
      console.log("ok");
      break;
    }
    case "pull": {
      need(args, 1, "pull <id> [hops]");
      if (!(await tryConnect(r))) break; // offline: nothing to pull
      const ids = await r.pullScope(args[0], Number(args[1] ?? 1));
      await r.waitIdle();
      console.log(`cached ${ids.length} notes`);
      break;
    }
    case "search": {
      need(args, 1, "search <query>");
      if (!(await tryConnect(r))) break;
      for (const h of await r.search(args.join(" "))) console.log(`${h.id}  ${h.title}`);
      break;
    }
    case "sync": {
      if (!(await tryConnect(r))) break;
      await r.waitIdle();
      console.log("synced", JSON.stringify(r.status()));
      break;
    }
    case "status":
      console.log(JSON.stringify({ ...r.status(), cachedNotes: r.workingSet() }, null, 2));
      break;
    default:
      console.error("commands: ls | cat | new | title | append | link | pull | search | sync | status");
      process.exit(1);
  }
  r.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
