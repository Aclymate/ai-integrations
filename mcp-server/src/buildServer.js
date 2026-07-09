import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { definition as explainScopeDef, handler as explainScope } from "./tools/explainScope.js";
import { definition as estimateDef, handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { definition as emissionFactorDef, handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { definition as compareDef, handler as compareFootprint } from "./tools/compareFootprint.js";
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
import { loadToolRegistry, startRegistryRefresh } from "./toolRegistry.js";
import { withTierGate } from "./middleware/toolTierGate.js";
import { withRateLimit } from "./middleware/rateLimit.js";

const envelopeToContent = (envelope) => ({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  ...(envelope.error ? { isError: true } : {})
});

const registerCalcTool = (server, { definition, inputShape, handler, getAuth }) => {
  server.tool(
    definition.name,
    definition.description,
    inputShape,
    { title: definition.title, readOnlyHint: true },
    withTierGate(
      definition.name,
      withRateLimit(
        definition.name,
        async (params) => envelopeToContent(await handler(params)),
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
      pendingScoutAuth: false
    };
  const server = new McpServer({ name: "aclymate", version: "0.1.0" });

  server.tool(
    explainScopeDef.name,
    explainScopeDef.description,
    {
      scope: z.enum(["1", "2", "3", "all"]).describe("Which GHG Protocol scope to explain"),
      industry: z.string().optional().describe("The industry or business type. Optional."),
    },
    { title: "Explain GHG Protocol Scope", readOnlyHint: true },
    withTierGate(
      explainScopeDef.name,
      withRateLimit(
        explainScopeDef.name,
        async ({ scope, industry }) => {
          const text = await explainScope({ scope, industry });
          return { content: [{ type: "text", text }] };
        },
        { getAuth }
      ),
      { getAuth }
    )
  );

  server.tool(
    estimateDef.name,
    estimateDef.description,
    {
      industry: z.string().describe("The business industry or type"),
      employees: z.number().describe("Number of employees"),
      location: z.string().optional().describe("City, state, or country. Optional."),
      additionalContext: z.string().optional().describe("Any additional context about the business. Optional."),
    },
    { title: "Estimate Business Carbon Footprint", readOnlyHint: true },
    withTierGate(
      estimateDef.name,
      withRateLimit(
        estimateDef.name,
        async ({ industry, employees, location, additionalContext }) => {
          const text = await estimateEmissions({ industry, employees, location, additionalContext });
          return { content: [{ type: "text", text }] };
        },
        { getAuth }
      ),
      { getAuth }
    )
  );

  server.tool(
    emissionFactorDef.name,
    emissionFactorDef.description,
    {
      activity: z.string().describe("The activity to get an emission factor for"),
      unit: z.string().optional().describe("The unit you want the factor in. Optional."),
    },
    { title: "Look Up Emission Factor", readOnlyHint: true },
    withTierGate(
      emissionFactorDef.name,
      withRateLimit(
        emissionFactorDef.name,
        async ({ activity, unit }) => {
          const text = await getEmissionFactor({ activity, unit });
          return { content: [{ type: "text", text }] };
        },
        { getAuth }
      ),
      { getAuth }
    )
  );

  server.tool(
    compareDef.name,
    compareDef.description,
    {
      industry: z.string().describe("The business industry or type"),
      employees: z.number().describe("Number of employees"),
      totalTonsCo2e: z.number().optional().describe("The company's actual annual emissions in tCO2e. Optional."),
    },
    { title: "Benchmark Business Footprint", readOnlyHint: true },
    withTierGate(
      compareDef.name,
      withRateLimit(
        compareDef.name,
        async ({ industry, employees, totalTonsCo2e }) => {
          const text = await compareFootprint({ industry, employees, totalTonsCo2e });
          return { content: [{ type: "text", text }] };
        },
        { getAuth }
      ),
      { getAuth }
    )
  );

  // B-Tier1-calcs — 7 tools (ordered alphabetically by tool name)
  registerCalcTool(server, {
    definition: calcDietDef,
    inputShape: calcDietShape,
    handler: calcDiet,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcElectricityDef,
    inputShape: calcElectricityShape,
    handler: calcElectricity,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcFlightDef,
    inputShape: calcFlightShape,
    handler: calcFlight,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcGasDef,
    inputShape: calcGasShape,
    handler: calcGas,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcOtherTransportDef,
    inputShape: calcOtherTransportShape,
    handler: calcOtherTransport,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcPetDef,
    inputShape: calcPetShape,
    handler: calcPet,
    getAuth
  });
  registerCalcTool(server, {
    definition: calcTrainDef,
    inputShape: calcTrainShape,
    handler: calcTrain,
    getAuth
  });

  return server;
};

export { buildServer, ensureRegistryLoaded };
