// stdio entry point: the process an agent (Claude Code/Desktop) launches.
// Config via env: CEPH_URL, CEPH_TOKEN (agent token), CEPH_SPACE.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CephalopodClient } from "./client.js";
import { BrainSocket } from "./brainsocket.js";
import { buildServer } from "./mcp.js";

// http(s)://host:7701 -> ws(s)://host:7700 (default brain ports)
function defaultWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port === "7701") u.port = "7700";
  return u.origin;
}

async function main() {
  const url = process.env.CEPH_URL ?? "http://localhost:7701";
  const token = process.env.CEPH_TOKEN;
  const space = process.env.CEPH_SPACE;
  if (!token || !space) {
    console.error("CEPH_TOKEN and CEPH_SPACE are required");
    process.exit(1);
  }
  const client = new CephalopodClient(url, token, space);

  // Connect the live-update socket; tolerate failure (subscriptions just won't fire).
  let socket: BrainSocket | undefined;
  try {
    const wsUrl = process.env.CEPH_WS_URL ?? defaultWsUrl(url);
    socket = new BrainSocket(wsUrl, token);
    await socket.connect();
    console.error(`cephalopod-mcp live updates via ${wsUrl}`);
  } catch (e) {
    console.error("live updates unavailable:", (e as Error).message);
    socket = undefined;
  }

  const server = buildServer(client, { socket });
  await server.connect(new StdioServerTransport());
  console.error(`cephalopod-mcp connected to ${url} (space: ${space})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
