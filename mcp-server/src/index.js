import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./buildServer.js";

const require_ = createRequire(import.meta.url);
const emissionsFactors = require_("@aclymatepackages/emissions-factors");

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set. Run via: doppler run --project aclymate-internal --config dev -- node src/index.js\n");
  process.exit(1);
}

// MCP stdio transport is inherently Tier-1 (no HTTP auth channel). The desktop
// extension's mcp-remote bridge translates stdio → HTTP and forwards Bearer
// tokens to the hosted /mcp endpoint — that path runs through server.js and
// its auth middleware. This local stdio path only serves the Tier-1 catalog.
//
// Warm the catalog index here too, so the user's first search_factors call in a
// session isn't the one that pays the one-time index-build cost.
emissionsFactors.warmup();
const server = await buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
