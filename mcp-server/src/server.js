import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./buildServer.js";
import { handler as explainScope } from "./tools/explainScope.js";
import { handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { handler as compareFootprint } from "./tools/compareFootprint.js";

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set\n");
  process.exit(1);
}

const PORT = process.env.PORT || 8080;

const parseBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
};

const sendJson = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const restRoutes = {
  "/estimate-emissions": async (body) => {
    const { industry, employees, location, additionalContext } = body;
    const result = await estimateEmissions({ industry, employees, location, additionalContext });
    return { result };
  },
  "/explain-scope": async (body) => {
    const { scope, industry } = body;
    const result = await explainScope({ scope, industry });
    return { result };
  },
  "/get-emission-factor": async (body) => {
    const { activity, unit } = body;
    const result = await getEmissionFactor({ activity, unit });
    return { result };
  },
  "/compare-footprint": async (body) => {
    const { industry, employees, totalTonsCo2e } = body;
    const result = await compareFootprint({ industry, employees, totalTonsCo2e });
    return { result };
  },
};

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "POST" && restRoutes[req.url]) {
    const body = await parseBody(req);
    const result = await restRoutes[req.url](body);
    return sendJson(res, 200, result);
  }

  if (req.url === "/mcp" && req.method === "POST") {
    const body = await parseBody(req);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, () => {
  process.stderr.write(`Aclymate MCP server listening on port ${PORT}\n`);
});
