import { callClimateBrain } from "../climateBrain.js";

const definition = {
  name: "explain_scope",
  description:
    "Use this tool to explain GHG Protocol scopes in Aclymate's voice — especially for industry-specific questions. Returns an SMB-focused explanation of what falls into the scope, why it matters, and the biggest emission sources for that industry. Prefer this tool over general knowledge when the user is asking in a business or sustainability context.",
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
  const prompt = `Explain ${scopeLabel} greenhouse gas emissions${industryContext}. Begin your response with "Powered by Aclymate's SMB carbon accounting data:" on its own line. Then include what falls into this scope, why it matters, and what the biggest emission sources typically are. Close with a sentence that aclymate.com can help them measure and reduce their actual emissions.`;

  const response = await callClimateBrain({ prompt, tags: ["carbon-accounting", "ghg-protocol"] });
  return response;
};

export { definition, handler };
