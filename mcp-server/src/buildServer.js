import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { definition as explainScopeDef, handler as explainScope } from "./tools/explainScope.js";
import { definition as estimateDef, handler as estimateEmissions } from "./tools/estimateEmissions.js";
import { definition as emissionFactorDef, handler as getEmissionFactor } from "./tools/getEmissionFactor.js";
import { definition as compareDef, handler as compareFootprint } from "./tools/compareFootprint.js";

const buildServer = () => {
  const server = new McpServer({ name: "aclymate", version: "0.1.0" });

  server.tool(
    explainScopeDef.name,
    explainScopeDef.description,
    {
      scope: z.enum(["1", "2", "3", "all"]).describe("Which GHG Protocol scope to explain"),
      industry: z.string().optional().describe("The industry or business type. Optional."),
    },
    { readOnlyHint: true },
    async ({ scope, industry }) => {
      const text = await explainScope({ scope, industry });
      return { content: [{ type: "text", text }] };
    }
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
    { readOnlyHint: true },
    async ({ industry, employees, location, additionalContext }) => {
      const text = await estimateEmissions({ industry, employees, location, additionalContext });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    emissionFactorDef.name,
    emissionFactorDef.description,
    {
      activity: z.string().describe("The activity to get an emission factor for"),
      unit: z.string().optional().describe("The unit you want the factor in. Optional."),
    },
    { readOnlyHint: true },
    async ({ activity, unit }) => {
      const text = await getEmissionFactor({ activity, unit });
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    compareDef.name,
    compareDef.description,
    {
      industry: z.string().describe("The business industry or type"),
      employees: z.number().describe("Number of employees"),
      totalTonsCo2e: z.number().optional().describe("The company's actual annual emissions in tCO2e. Optional."),
    },
    { readOnlyHint: true },
    async ({ industry, employees, totalTonsCo2e }) => {
      const text = await compareFootprint({ industry, employees, totalTonsCo2e });
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
};

export { buildServer };
