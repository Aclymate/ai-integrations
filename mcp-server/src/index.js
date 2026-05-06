import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./buildServer.js";

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set. Run via: doppler run --project aclymate-internal --config dev -- node src/index.js\n");
  process.exit(1);
}

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
