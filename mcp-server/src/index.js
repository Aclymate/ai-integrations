import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./buildServer.js";

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set. Run via: doppler run --project aclymate-internal --config dev -- node src/index.js\n");
  process.exit(1);
}

// MCP stdio transport is inherently Tier-1 (no HTTP auth channel). The desktop
// extension's mcp-remote bridge translates stdio → HTTP and forwards Bearer
// tokens to the hosted /mcp endpoint — that path runs through server.js and
// its auth middleware. This local stdio path only serves the Tier-1 catalog.
const server = await buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
