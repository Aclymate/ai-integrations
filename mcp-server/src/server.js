import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, ensureRegistryLoaded } from "./buildServer.js";
import { handler as explainScope } from "./tools/explainScope.js";
import { handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { handler as compareFootprint } from "./tools/compareFootprint.js";
// B-Tier1-calcs — 7 tools (Tier-1 calc-based)
import { handler as calcFlight } from "./tools/calcs/tier1/calculateFlightEmissions.js";
import { handler as calcTrain } from "./tools/calcs/tier1/calculateTrainEmissions.js";
import { handler as calcOtherTransport } from "./tools/calcs/tier1/calculateOtherTransportEmissions.js";
import { handler as calcElectricity } from "./tools/calcs/tier1/calculateElectricityEmissions.js";
import { handler as calcGas } from "./tools/calcs/tier1/calculateGasEmissions.js";
import { handler as calcDiet } from "./tools/calcs/tier1/calculateDietEmissions.js";
import { handler as calcPet } from "./tools/calcs/tier1/calculatePetEmissions.js";
import { authMiddleware } from "./middleware/auth.js";
import { enforceToolTierForRest } from "./middleware/toolTierGate.js";
import {
  enforceRateLimitForRest,
  applySuccessHintToEnvelope
} from "./middleware/rateLimit.js";
import {
  buildErrorEnvelope,
  sendJson
} from "./responseEnvelope.js";

const REQUIRED_ENV = [
  ["INTERNAL_API_KEY", "aclymate-internal knowledgeCompose shared secret"],
  ["RENEW_WEST_INTERNAL_API_URL", "renew-west internalApi Cloud Run URL"],
  ["RENEW_WEST_INTERNAL_API_AUDIENCE", "OIDC audience for internalApi"],
  [
    "MCP_IP_HASH_SALT",
    "salt for req.auth.ipHash — without it, ipHash is a public-recipe sha256 that's rainbow-tableable for IPv4"
  ]
];

REQUIRED_ENV.forEach(([name, hint]) => {
  if (!process.env[name]) {
    process.stderr.write(
      `[server] ${name} is not set — ${hint}. Run via: doppler run --project aclymate-internal --config dev -- node src/server.js\n`
    );
    process.exit(1);
  }
});

const PORT = process.env.PORT || 8080;

const parseBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  return JSON.parse(raw);
};

const sendInvalidJson = (res) =>
  sendJson(
    res,
    400,
    buildErrorEnvelope({
      code: "invalid_json",
      http_status: 400,
      message: "Request body must be valid JSON.",
      upgradeHint: null
    })
  );

const sendInternalError = (res) =>
  sendJson(
    res,
    500,
    buildErrorEnvelope({
      code: "internal_error",
      http_status: 500,
      message: "An unexpected error occurred.",
      upgradeHint: null
    })
  );

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
  },
  // B-Tier1-calcs — 7 REST routes (each returns the FM §4 envelope directly)
  "/calculate-diet-emissions": {
    toolName: "calculate_diet_emissions",
    execute: async (body) => calcDiet(body)
  },
  "/calculate-electricity-emissions": {
    toolName: "calculate_electricity_emissions",
    execute: async (body) => calcElectricity(body)
  },
  "/calculate-flight-emissions": {
    toolName: "calculate_flight_emissions",
    execute: async (body) => calcFlight(body)
  },
  "/calculate-gas-emissions": {
    toolName: "calculate_gas_emissions",
    execute: async (body) => calcGas(body)
  },
  "/calculate-other-transport-emissions": {
    toolName: "calculate_other_transport_emissions",
    execute: async (body) => calcOtherTransport(body)
  },
  "/calculate-pet-emissions": {
    toolName: "calculate_pet_emissions",
    execute: async (body) => calcPet(body)
  },
  "/calculate-train-emissions": {
    toolName: "calculate_train_emissions",
    execute: async (body) => calcTrain(body)
  }
};

const handleRestRoute = async (req, res, route) => {
  const chain = withMiddleware(
    authMiddleware,
    enforceToolTierForRest(route.toolName),
    enforceRateLimitForRest(route.toolName)
  );
  const outcome = await chain(req, res);
  if (!outcome?.proceed) {
    return;
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: "invalid_json_body",
        route: route.toolName,
        message: err.message
      }) + "\n"
    );
    sendInvalidJson(res);
    return;
  }
  const result = await route.execute(body);
  const status = result?.error?.http_status ?? 200;
  const withRateLimitHint =
    req.rateLimit && !result?.error
      ? applySuccessHintToEnvelope(result, req.rateLimit.callsRemainingToday)
      : result;
  sendJson(res, status, withRateLimitHint);
};

// buildServer({auth}) is called PER REQUEST. Each call captures req.auth in a
// `getAuth` closure that is threaded into every withTierGate(...) wrap inside
// buildServer.js. If a future maintainer hoists `buildServer` to module scope
// to save latency, per-request auth is lost — stale/null/cross-request. Do NOT
// do that without also passing auth explicitly through the SDK's extra.authInfo.
const handleMcpRoute = async (req, res) => {
  const chain = withMiddleware(authMiddleware);
  const outcome = await chain(req, res);
  if (!outcome?.proceed) {
    return;
  }
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: "invalid_json_body",
        route: "/mcp",
        message: err.message
      }) + "\n"
    );
    sendInvalidJson(res);
    return;
  }
  const server = await buildServer({ auth: req.auth });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  return transport.handleRequest(req, res, body);
};

const httpServer = createServer(async (req, res) => {
  try {
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
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: "unhandled_request_error",
        url: req.url,
        method: req.method,
        message: err.message
      }) + "\n"
    );
    if (!res.headersSent) {
      sendInternalError(res);
    }
  }
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
