// stdio entry point: the process an agent (Claude Code/Desktop) launches.
// Config via env: CEPH_URL, CEPH_TOKEN (agent token), CEPH_SPACE.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CephalopodClient } from "./client.js";
import { buildServer } from "./mcp.js";

async function main() {
  const url = process.env.CEPH_URL ?? "http://localhost:7701";
  const token = process.env.CEPH_TOKEN;
  const space = process.env.CEPH_SPACE;
  if (!token || !space) {
    console.error("CEPH_TOKEN and CEPH_SPACE are required");
    process.exit(1);
  }
  const client = new CephalopodClient(url, token, space);
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  console.error(`cephalopod-mcp connected to ${url} (space: ${space})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
