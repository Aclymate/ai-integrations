import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, ensureRegistryLoaded } from "./buildServer.js";
import { handler as explainScope } from "./tools/explainScope.js";
import { handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { handler as compareFootprint } from "./tools/compareFootprint.js";
import { authMiddleware, sendJson } from "./middleware/auth.js";
import { enforceToolTierForRest } from "./middleware/toolTierGate.js";

if (!process.env.INTERNAL_API_KEY) {
  process.stderr.write("INTERNAL_API_KEY is not set\n");
  process.exit(1);
}

if (!process.env.RENEW_WEST_INTERNAL_API_URL) {
  process.stderr.write("RENEW_WEST_INTERNAL_API_URL is not set\n");
  process.exit(1);
}

if (!process.env.RENEW_WEST_INTERNAL_API_AUDIENCE) {
  process.stderr.write("RENEW_WEST_INTERNAL_API_AUDIENCE is not set\n");
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

const withMiddleware = (...middlewares) => async (req, res) => {
  const runMiddleware = async (index) => {
    if (index >= middlewares.length) {
      return { proceed: true };
    }
    const result = await middlewares[index](req, res);
    if (!result?.proceed) {
      return result || { proceed: false };
    }
    return runMiddleware(index + 1);
  };
  return runMiddleware(0);
};

const restRouteHandlers = {
  "/estimate-emissions": {
    toolName: "estimate_emissions",
    execute: async (body) => {
      const { industry, employees, location, additionalContext } = body;
      const result = await estimateEmissions({
        industry,
        employees,
        location,
        additionalContext
      });
      return { result };
    }
  },
  "/explain-scope": {
    toolName: "explain_scope",
    execute: async (body) => {
      const { scope, industry } = body;
      const result = await explainScope({ scope, industry });
      return { result };
    }
  },
  "/get-emission-factor": {
    toolName: "get_emission_factor",
    execute: async (body) => {
      const { activity, unit } = body;
      const result = await getEmissionFactor({ activity, unit });
      return { result };
    }
  },
  "/compare-footprint": {
    toolName: "compare_business_footprint",
    execute: async (body) => {
      const { industry, employees, totalTonsCo2e } = body;
      const result = await compareFootprint({
        industry,
        employees,
        totalTonsCo2e
      });
      return { result };
    }
  }
};

const handleRestRoute = async (req, res, route) => {
  const chain = withMiddleware(
    authMiddleware,
    enforceToolTierForRest(route.toolName)
  );
  const outcome = await chain(req, res);
  if (!outcome?.proceed) {
    return;
  }
  const body = await parseBody(req);
  const result = await route.execute(body);
  sendJson(res, 200, result);
};

const handleMcpRoute = async (req, res) => {
  const chain = withMiddleware(authMiddleware);
  const outcome = await chain(req, res);
  if (!outcome?.proceed) {
    return;
  }
  const body = await parseBody(req);
  const server = await buildServer({ auth: req.auth });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  return transport.handleRequest(req, res, body);
};

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }

  const restRoute = restRouteHandlers[req.url];
  if (req.method === "POST" && restRoute) {
    return handleRestRoute(req, res, restRoute);
  }

  if (req.url === "/mcp" && req.method === "POST") {
    return handleMcpRoute(req, res);
  }

  res.writeHead(404);
  res.end();
});

ensureRegistryLoaded()
  .then(() => {
    httpServer.listen(PORT, () => {
      process.stderr.write(
        `Aclymate MCP server listening on port ${PORT}\n`
      );
    });
  })
  .catch((err) => {
    process.stderr.write(
      `Failed to load mcp-tool-registry at boot: ${err.message}\n`
    );
    process.exit(1);
  });
