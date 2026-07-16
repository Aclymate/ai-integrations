import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Phase A — 4 tools (all envelope-migrated by B-Tier1-browse)
import {
  definition as explainScopeDef,
  inputShape as explainScopeShape,
  handler as explainScope
} from "./tools/explainScope.js";
import {
  definition as estimateDef,
  inputShape as estimateShape,
  handler as estimateEmissions
} from "./tools/estimateEmissions.js";
import {
  definition as emissionFactorDef,
  inputShape as emissionFactorShape,
  handler as getEmissionFactor
} from "./tools/getEmissionFactor.js";
import {
  definition as compareDef,
  inputShape as compareShape,
  handler as compareFootprint
} from "./tools/compareFootprint.js";
// B-Tier1-browse — 5 tools (Tier-1 catalog browse)
import {
  definition as lookupFactorByIdDef,
  inputShape as lookupFactorByIdShape,
  handler as lookupFactorById
} from "./tools/browse/lookupFactorById.js";
import {
  definition as findFactorDef,
  inputShape as findFactorShape,
  handler as findFactor
} from "./tools/browse/findFactor.js";
import {
  definition as searchFactorsDef,
  inputShape as searchFactorsShape,
  handler as searchFactors
} from "./tools/browse/searchFactors.js";
import {
  definition as listFactorTypesDef,
  inputShape as listFactorTypesShape,
  handler as listFactorTypes
} from "./tools/browse/listFactorTypes.js";
import {
  definition as listFactorKeyValuesDef,
  inputShape as listFactorKeyValuesShape,
  handler as listFactorKeyValues
} from "./tools/browse/listFactorKeyValues.js";
// B-Tier1-calcs — 7 tools (Tier-1 calc-based)
import {
  definition as calcFlightDef,
  inputShape as calcFlightShape,
  handler as calcFlight
} from "./tools/calcs/tier1/calculateFlightEmissions.js";
import {
  definition as calcTrainDef,
  inputShape as calcTrainShape,
  handler as calcTrain
} from "./tools/calcs/tier1/calculateTrainEmissions.js";
import {
  definition as calcOtherTransportDef,
  inputShape as calcOtherTransportShape,
  handler as calcOtherTransport
} from "./tools/calcs/tier1/calculateOtherTransportEmissions.js";
import {
  definition as calcElectricityDef,
  inputShape as calcElectricityShape,
  handler as calcElectricity
} from "./tools/calcs/tier1/calculateElectricityEmissions.js";
import {
  definition as calcGasDef,
  inputShape as calcGasShape,
  handler as calcGas
} from "./tools/calcs/tier1/calculateGasEmissions.js";
import {
  definition as calcDietDef,
  inputShape as calcDietShape,
  handler as calcDiet
} from "./tools/calcs/tier1/calculateDietEmissions.js";
import {
  definition as calcPetDef,
  inputShape as calcPetShape,
  handler as calcPet
} from "./tools/calcs/tier1/calculatePetEmissions.js";
// B-Tier1-recommender — 1 tool
import {
  definition as recommendReductionsDef,
  inputShape as recommendReductionsShape,
  handler as recommendReductions
} from "./tools/recommender/recommendEmissionsReductions.js";
import { loadToolRegistry, startRegistryRefresh } from "./toolRegistry.js";
import { withTierGate } from "./middleware/toolTierGate.js";
import { withRateLimit } from "./middleware/rateLimit.js";
import { withMetering } from "./middleware/metering.js";

const envelopeToContent = (envelope) => ({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  ...(envelope.error ? { isError: true } : {})
});

const registerEnvelopeTool = (server, { definition, inputShape, handler, getAuth }) => {
  server.tool(
    definition.name,
    definition.description,
    inputShape,
    { title: definition.title, readOnlyHint: true },
    withMetering(
      definition.name,
      withTierGate(
        definition.name,
        withRateLimit(
          definition.name,
          async (params) => envelopeToContent(await handler(params)),
          { getAuth }
        ),
        { getAuth }
      ),
      { getAuth }
    )
  );
};

let registryLoadPromise = null;

const ensureRegistryLoaded = () => {
  if (!registryLoadPromise) {
    registryLoadPromise = loadToolRegistry().then((tools) => {
      startRegistryRefresh();
      return tools;
    });
  }
  return registryLoadPromise;
};

// Called PER HTTP REQUEST from server.js so `getAuth` closes over that
// request's `req.auth`. Do NOT hoist to module scope — see the comment
// on handleMcpRoute in server.js for the failure mode. `withTierGate`
// enforces `getAuth` at registration time; if you add a new tool below,
// you MUST pass `{ getAuth }` — the HOC throws otherwise, on purpose.
const buildServer = async ({ auth = null } = {}) => {
  await ensureRegistryLoaded();

  const getAuth = () =>
    auth || {
      tier: "tier-1",
      accountId: null,
      keyId: null,
      testMode: false,
      rateLimit: null,
      ipHash: null,
      pendingScoutAuth: false,
      meteringBypass: false
    };
  const server = new McpServer({ name: "aclymate", version: "0.1.0" });

  // Phase A — 4 tools (envelope-migrated)
  registerEnvelopeTool(server, {
    definition: compareDef,
    inputShape: compareShape,
    handler: compareFootprint,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: estimateDef,
    inputShape: estimateShape,
    handler: estimateEmissions,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: explainScopeDef,
    inputShape: explainScopeShape,
    handler: explainScope,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: emissionFactorDef,
    inputShape: emissionFactorShape,
    handler: getEmissionFactor,
    getAuth
  });

  // B-Tier1-browse — 5 catalog browse tools
  registerEnvelopeTool(server, {
    definition: findFactorDef,
    inputShape: findFactorShape,
    handler: findFactor,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: listFactorKeyValuesDef,
    inputShape: listFactorKeyValuesShape,
    handler: listFactorKeyValues,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: listFactorTypesDef,
    inputShape: listFactorTypesShape,
    handler: listFactorTypes,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: lookupFactorByIdDef,
    inputShape: lookupFactorByIdShape,
    handler: lookupFactorById,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: searchFactorsDef,
    inputShape: searchFactorsShape,
    handler: searchFactors,
    getAuth
  });

  // B-Tier1-calcs — 7 calc tools
  registerEnvelopeTool(server, {
    definition: calcDietDef,
    inputShape: calcDietShape,
    handler: calcDiet,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcElectricityDef,
    inputShape: calcElectricityShape,
    handler: calcElectricity,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcFlightDef,
    inputShape: calcFlightShape,
    handler: calcFlight,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcGasDef,
    inputShape: calcGasShape,
    handler: calcGas,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcOtherTransportDef,
    inputShape: calcOtherTransportShape,
    handler: calcOtherTransport,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcPetDef,
    inputShape: calcPetShape,
    handler: calcPet,
    getAuth
  });
  registerEnvelopeTool(server, {
    definition: calcTrainDef,
    inputShape: calcTrainShape,
    handler: calcTrain,
    getAuth
  });

  // B-Tier1-recommender — 1 tool
  registerEnvelopeTool(server, {
    definition: recommendReductionsDef,
    inputShape: recommendReductionsShape,
    handler: recommendReductions,
    getAuth
  });

  return server;
};

export { buildServer, ensureRegistryLoaded };
