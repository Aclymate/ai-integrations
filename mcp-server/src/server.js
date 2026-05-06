import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./buildServer.js";

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set\n");
  process.exit(1);
}

const PORT = process.env.PORT || 8080;

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => {
  process.stderr.write(`Aclymate MCP server listening on port ${PORT}\n`);
});
