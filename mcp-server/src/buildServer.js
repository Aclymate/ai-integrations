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
// B-Tier2-tools — 8 tools (Tier-2 calc-based + stored-result layer)
import {
  definition as classifyVendorDef,
  inputShape as classifyVendorShape,
  handler as classifyVendor
} from "./tools/tier2/classifyVendorByIndustry.js";
import {
  definition as calcRefrigerantDef,
  inputShape as calcRefrigerantShape,
  handler as calcRefrigerant
} from "./tools/tier2/calculateRefrigerantEmissions.js";
import {
  definition as calcSteamDef,
  inputShape as calcSteamShape,
  handler as calcSteam
} from "./tools/tier2/calculateSteamEmissions.js";
import {
  definition as calcWaterDef,
  inputShape as calcWaterShape,
  handler as calcWater
} from "./tools/tier2/calculateWaterEmissions.js";
import {
  definition as calcVehicleDef,
  inputShape as calcVehicleShape,
  handler as calcVehicle
} from "./tools/tier2/calculateVehicleEmissions.js";
import {
  definition as calcShippingDef,
  inputShape as calcShippingShape,
  handler as calcShipping
} from "./tools/tier2/calculateShippingEmissions.js";
import {
  definition as calcCommuteDef,
  inputShape as calcCommuteShape,
  handler as calcCommute
} from "./tools/tier2/calculateCommuteEmissions.js";
import {
  definition as calcOfficeUtilityDef,
  inputShape as calcOfficeUtilityShape,
  handler as calcOfficeUtility
} from "./tools/tier2/calculateOfficeUtilityEmissions.js";
// B-Tier3-reads — 6 tools (5 read-only customer-data + PCF)
import {
  definition as getEmissionsSummaryDef,
  inputShape as getEmissionsSummaryShape,
  handler as getEmissionsSummary
} from "./tools/tier3/reads/getEmissionsSummary.js";
import {
  definition as listEmissionSourcesDef,
  inputShape as listEmissionSourcesShape,
  handler as listEmissionSources
} from "./tools/tier3/reads/listEmissionSources.js";
import {
  definition as getVendorBreakdownDef,
  inputShape as getVendorBreakdownShape,
  handler as getVendorBreakdown
} from "./tools/tier3/reads/getVendorBreakdown.js";
import {
  definition as auditANumberDef,
  inputShape as auditANumberShape,
  handler as auditANumber
} from "./tools/tier3/reads/auditANumber.js";
import {
  definition as disclosureResponseDef,
  inputShape as disclosureResponseShape,
  handler as disclosureResponse
} from "./tools/tier3/reads/generateDisclosureResponse.js";
import {
  definition as productFootprintDef,
  inputShape as productFootprintShape,
  handler as productFootprint
} from "./tools/tier3/reads/calculateProductCarbonFootprint.js";
import { loadToolRegistry, startRegistryRefresh } from "./toolRegistry.js";
import { withTierGate } from "./middleware/toolTierGate.js";
import { withRateLimit } from "./middleware/rateLimit.js";
import { withMetering } from "./middleware/metering.js";
import { withStoredResults } from "./middleware/storedResults.js";
import { withAudit } from "./middleware/audit.js";

const envelopeToContent = (envelope) => ({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  ...(envelope.error ? { isError: true } : {})
});

const registerEnvelopeTool = (
  server,
  { definition, inputShape, handler, getAuth, getReq, getSourceAgent }
) => {
  server.tool(
    definition.name,
    definition.description,
    inputShape,
    { title: definition.title, readOnlyHint: true },
    withAudit(
      definition.name,
      withMetering(
        definition.name,
        withTierGate(
          definition.name,
          withRateLimit(
            definition.name,
            async (params) =>
              envelopeToContent(
                await withStoredResults(definition.name, handler, {
                  getAuth,
                  getReq
                })(params)
              ),
            { getAuth }
          ),
          { getAuth }
        ),
        { getAuth }
      ),
      { getAuth, getSourceAgent }
    )
  );
};

// Tier-3 customer-data reads (B-Tier3-reads). Same middleware order as
// registerEnvelopeTool MINUS withStoredResults (tier-3 reads must not write
// mcp-stored-results — those are Tier-2). The handler receives `{ auth }` as
// its second argument so it can read `auth.accountId` (the companyId) and pass
// it to the internalApi read wrappers. withAudit stays outermost so it observes
// the final response including any tier/rate-limit errors.
const registerCustomerDataTool = (
  server,
  { definition, inputShape, handler, getAuth, getSourceAgent }
) => {
  server.tool(
    definition.name,
    definition.description,
    inputShape,
    { title: definition.title, readOnlyHint: true },
    withAudit(
      definition.name,
      withMetering(
        definition.name,
        withTierGate(
          definition.name,
          withRateLimit(
            definition.name,
            async (params) =>
              envelopeToContent(await handler(params, { auth: getAuth() })),
            { getAuth }
          ),
          { getAuth }
        ),
        { getAuth }
      ),
      { getAuth, getSourceAgent }
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

// Called PER HTTP REQUEST from server.js so `getAuth`/`getReq` close over
// that request's `req.auth`/`req`. Do NOT hoist to module scope — see the
// comment on handleMcpRoute in server.js for the failure mode. `withTierGate`
// enforces `getAuth` at registration time; if you add a new tool below,
// you MUST pass `{ getAuth, getReq }` — the HOC throws otherwise for getAuth
// (getReq is optional, only consumed by withStoredResults).
const buildServer = async ({ auth = null, req = null } = {}) => {
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
  // Only consumed by withStoredResults's detectSourceAgent — defaults to null
  // (source_agent "unknown") rather than throwing, unlike getAuth.
  const getReq = () => req;
  // req.sourceAgent is computed once at the request boundary in server.js
  // (handleMcpRoute) via the shared detectSourceAgent(req, req.auth) — reuse
  // that value here rather than re-detecting it for withAudit.
  const getSourceAgent = () => req?.sourceAgent || "unknown";
  const server = new McpServer({ name: "aclymate", version: "0.1.0" });

  // Phase A — 4 tools (envelope-migrated)
  registerEnvelopeTool(server, {
    definition: compareDef,
    inputShape: compareShape,
    handler: compareFootprint,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: estimateDef,
    inputShape: estimateShape,
    handler: estimateEmissions,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: explainScopeDef,
    inputShape: explainScopeShape,
    handler: explainScope,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: emissionFactorDef,
    inputShape: emissionFactorShape,
    handler: getEmissionFactor,
    getAuth,
    getReq,
    getSourceAgent
  });

  // B-Tier1-browse — 5 catalog browse tools
  registerEnvelopeTool(server, {
    definition: findFactorDef,
    inputShape: findFactorShape,
    handler: findFactor,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: listFactorKeyValuesDef,
    inputShape: listFactorKeyValuesShape,
    handler: listFactorKeyValues,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: listFactorTypesDef,
    inputShape: listFactorTypesShape,
    handler: listFactorTypes,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: lookupFactorByIdDef,
    inputShape: lookupFactorByIdShape,
    handler: lookupFactorById,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: searchFactorsDef,
    inputShape: searchFactorsShape,
    handler: searchFactors,
    getAuth,
    getReq,
    getSourceAgent
  });

  // B-Tier1-calcs — 7 calc tools
  registerEnvelopeTool(server, {
    definition: calcDietDef,
    inputShape: calcDietShape,
    handler: calcDiet,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcElectricityDef,
    inputShape: calcElectricityShape,
    handler: calcElectricity,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcFlightDef,
    inputShape: calcFlightShape,
    handler: calcFlight,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcGasDef,
    inputShape: calcGasShape,
    handler: calcGas,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcOtherTransportDef,
    inputShape: calcOtherTransportShape,
    handler: calcOtherTransport,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcPetDef,
    inputShape: calcPetShape,
    handler: calcPet,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcTrainDef,
    inputShape: calcTrainShape,
    handler: calcTrain,
    getAuth,
    getReq,
    getSourceAgent
  });

  // B-Tier1-recommender — 1 tool
  registerEnvelopeTool(server, {
    definition: recommendReductionsDef,
    inputShape: recommendReductionsShape,
    handler: recommendReductions,
    getAuth,
    getReq,
    getSourceAgent
  });

  // B-Tier2-tools — 8 tools (Tier-2 calc-based + stored-result layer)
  registerEnvelopeTool(server, {
    definition: classifyVendorDef,
    inputShape: classifyVendorShape,
    handler: classifyVendor,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcRefrigerantDef,
    inputShape: calcRefrigerantShape,
    handler: calcRefrigerant,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcSteamDef,
    inputShape: calcSteamShape,
    handler: calcSteam,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcWaterDef,
    inputShape: calcWaterShape,
    handler: calcWater,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcVehicleDef,
    inputShape: calcVehicleShape,
    handler: calcVehicle,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcShippingDef,
    inputShape: calcShippingShape,
    handler: calcShipping,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcCommuteDef,
    inputShape: calcCommuteShape,
    handler: calcCommute,
    getAuth,
    getReq,
    getSourceAgent
  });
  registerEnvelopeTool(server, {
    definition: calcOfficeUtilityDef,
    inputShape: calcOfficeUtilityShape,
    handler: calcOfficeUtility,
    getAuth,
    getReq,
    getSourceAgent
  });

  // B-Tier3-reads — 6 tools (5 read-only customer-data + PCF)
  registerCustomerDataTool(server, {
    definition: getEmissionsSummaryDef,
    inputShape: getEmissionsSummaryShape,
    handler: getEmissionsSummary,
    getAuth,
    getSourceAgent
  });
  registerCustomerDataTool(server, {
    definition: listEmissionSourcesDef,
    inputShape: listEmissionSourcesShape,
    handler: listEmissionSources,
    getAuth,
    getSourceAgent
  });
  registerCustomerDataTool(server, {
    definition: getVendorBreakdownDef,
    inputShape: getVendorBreakdownShape,
    handler: getVendorBreakdown,
    getAuth,
    getSourceAgent
  });
  registerCustomerDataTool(server, {
    definition: auditANumberDef,
    inputShape: auditANumberShape,
    handler: auditANumber,
    getAuth,
    getSourceAgent
  });
  registerCustomerDataTool(server, {
    definition: disclosureResponseDef,
    inputShape: disclosureResponseShape,
    handler: disclosureResponse,
    getAuth,
    getSourceAgent
  });
  registerCustomerDataTool(server, {
    definition: productFootprintDef,
    inputShape: productFootprintShape,
    handler: productFootprint,
    getAuth,
    getSourceAgent
  });

  return server;
};

export { buildServer, ensureRegistryLoaded };
