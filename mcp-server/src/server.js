import { createServer } from "node:http";
import { createRequire } from "node:module";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, ensureRegistryLoaded } from "./buildServer.js";

const require_ = createRequire(import.meta.url);
const emissionsFactors = require_("@aclymatepackages/emissions-factors");
// Phase A — 4 envelope-migrated tools
import { handler as explainScope } from "./tools/explainScope.js";
import { handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { handler as compareFootprint } from "./tools/compareFootprint.js";
// B-Tier1-browse — 5 catalog browse tools
import { handler as lookupFactorById } from "./tools/browse/lookupFactorById.js";
import { handler as findFactor } from "./tools/browse/findFactor.js";
import { handler as searchFactors } from "./tools/browse/searchFactors.js";
import { handler as listFactorTypes } from "./tools/browse/listFactorTypes.js";
import { handler as listFactorKeyValues } from "./tools/browse/listFactorKeyValues.js";
// B-Tier1-calcs — 7 tools (Tier-1 calc-based)
import { handler as calcFlight } from "./tools/calcs/tier1/calculateFlightEmissions.js";
import { handler as calcTrain } from "./tools/calcs/tier1/calculateTrainEmissions.js";
import { handler as calcOtherTransport } from "./tools/calcs/tier1/calculateOtherTransportEmissions.js";
import { handler as calcElectricity } from "./tools/calcs/tier1/calculateElectricityEmissions.js";
import { handler as calcGas } from "./tools/calcs/tier1/calculateGasEmissions.js";
import { handler as calcDiet } from "./tools/calcs/tier1/calculateDietEmissions.js";
import { handler as calcPet } from "./tools/calcs/tier1/calculatePetEmissions.js";
// B-Tier1-recommender — 1 tool
import { handler as recommendReductions } from "./tools/recommender/recommendEmissionsReductions.js";
import { authMiddleware } from "./middleware/auth.js";
import { detectSourceAgent } from "./middleware/sourceAgent.js";
import { runAudited } from "./middleware/audit.js";
import { enforceMeteringForRest } from "./middleware/metering.js";
import { enforceToolTierForRest } from "./middleware/toolTierGate.js";
import {
  enforceRateLimitForRest,
  buildRateLimitSuccessHint
} from "./middleware/rateLimit.js";
import { applySuccessHintToEnvelope } from "./middleware/upgradeHints.js";
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
  // Phase A — 4 REST routes (envelope-migrated by B-Tier1-browse)
  "/estimate-emissions": {
    toolName: "estimate_emissions",
    execute: async (body) => estimateEmissions(body)
  },
  "/explain-scope": {
    toolName: "explain_scope",
    execute: async (body) => explainScope(body)
  },
  "/get-emission-factor": {
    toolName: "get_emission_factor",
    execute: async (body) => getEmissionFactor(body)
  },
  "/compare-footprint": {
    toolName: "compare_business_footprint",
    execute: async (body) => compareFootprint(body)
  },
  // B-Tier1-browse — 5 REST routes (each returns the FM §4 envelope directly)
  "/lookup-factor-by-id": {
    toolName: "lookup_factor_by_id",
    execute: async (body) => lookupFactorById(body)
  },
  "/find-factor": {
    toolName: "find_factor",
    execute: async (body) => findFactor(body)
  },
  "/search-factors": {
    toolName: "search_factors",
    execute: async (body) => searchFactors(body)
  },
  "/list-factor-types": {
    toolName: "list_factor_types",
    execute: async (body) => listFactorTypes(body)
  },
  "/list-factor-key-values": {
    toolName: "list_factor_key_values",
    execute: async (body) => listFactorKeyValues(body)
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
  },
  // B-Tier1-recommender — 1 REST route (returns the FM §4 envelope directly)
  "/recommend-emissions-reductions": {
    toolName: "recommend_emissions_reductions",
    execute: async (body) => recommendReductions(body)
  }
};

const handleRestRoute = async (req, res, route) => {
  const chain = withMiddleware(
    authMiddleware,
    enforceMeteringForRest(route.toolName),
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
  // Audit the REST surface too — a thrown handler records an error-marker and
  // re-throws (see runAudited). Tier-3 REST tools inherit auditing for free.
  const result = await runAudited({
    run: () => route.execute(body),
    auth: req.auth,
    sourceAgent: detectSourceAgent(req, req.auth),
    toolName: route.toolName,
    inputs: body
  });
  const status = result?.error?.http_status ?? 200;
  // Anonymous (req.meter) and authenticated (req.rateLimit) nudge zones are
  // disjoint by construction — both middlewares' shouldSkip predicates are
  // mutually exclusive on keyId, so at most one of these is ever populated.
  const hint =
    req.meter?.hint ??
    (req.rateLimit ? buildRateLimitSuccessHint(req.rateLimit) : null);
  const withHint =
    hint && !result?.error ? applySuccessHintToEnvelope(result, hint) : result;
  sendJson(res, status, withHint);
};

// buildServer({auth, req}) is called PER REQUEST. Each call captures req.auth
// and req in `getAuth`/`getReq` closures that are threaded into every
// withTierGate(...)/withStoredResults(...) wrap inside buildServer.js. If a
// future maintainer hoists `buildServer` to module scope to save latency,
// per-request auth/req is lost — stale/null/cross-request. Do NOT do that
// without also passing auth explicitly through the SDK's extra.authInfo.
const handleMcpRoute = async (req, res) => {
  const chain = withMiddleware(authMiddleware);
  const outcome = await chain(req, res);
  if (!outcome?.proceed) {
    return;
  }
  // Computed once here (the request boundary) and threaded to consuming
  // middleware via getReq() — not re-detected per middleware.
  req.sourceAgent = detectSourceAgent(req, req.auth);
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
  const server = await buildServer({ auth: req.auth, req });
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

// Building the emissions-factors catalog index (exact-match + fuzzy) is a one-time cost
// of tens of seconds against the ~100MB catalog. Warming it here, before the server
// accepts connections, means a real user's first search_factors call never pays it.
const warmEmissionsFactorsIndex = async () => {
  const startedAt = Date.now();
  emissionsFactors.warmup();
  process.stderr.write(
    `Warmed emissions-factors catalog index in ${Date.now() - startedAt}ms\n`
  );
};

Promise.all([ensureRegistryLoaded(), warmEmissionsFactorsIndex()])
  .then(() => {
    httpServer.listen(PORT, () => {
      process.stderr.write(
        `Aclymate MCP server listening on port ${PORT}\n`
      );
    });
  })
  .catch((err) => {
    process.stderr.write(
      `Failed to complete boot sequence: ${err.message}\n`
    );
    process.exit(1);
  });
