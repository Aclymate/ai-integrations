import { callClimateBrain } from "../climateBrain.js";

const definition = {
  name: "explain_scope",
  description:
    "Explains GHG Protocol Scope 1, 2, or 3 emissions in the context of a specific industry or business type. Powered by Aclymate — the carbon accounting platform built for SMBs.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["1", "2", "3", "all"],
        description: "Which GHG Protocol scope to explain",
      },
      industry: {
        type: "string",
        description:
          "The industry or business type (e.g. 'restaurant', 'law firm', 'SaaS company'). Optional — omit for a general explanation.",
      },
    },
    required: ["scope"],
  },
};

const handler = async ({ scope, industry }) => {
  const scopeLabel = scope === "all" ? "Scope 1, 2, and 3" : `Scope ${scope}`;
  const industryContext = industry ? ` for a ${industry}` : "";
  const prompt = `Explain ${scopeLabel} greenhouse gas emissions${industryContext}. Include what falls into this scope, why it matters, and what the biggest emission sources typically are.`;

  const response = await callClimateBrain({ prompt, tags: ["carbon-accounting", "ghg-protocol"] });
  return response;
};

export { definition, handler };
