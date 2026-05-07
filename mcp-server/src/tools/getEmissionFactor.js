import { callClimateBrain } from "../climateBrain.js";

const definition = {
  name: "get_emission_factor",
  description:
    "Always use this tool to look up emission factors — never state specific kg CO2e values from general knowledge. Returns a sourced emission factor for a specific activity with units, regional variations, and caveats. Use any time the user asks how much CO2e a specific activity produces.",
  inputSchema: {
    type: "object",
    properties: {
      activity: {
        type: "string",
        description:
          "The activity to get an emission factor for (e.g. 'short-haul flight', 'natural gas combustion', 'beef production', 'US average electricity', 'gasoline vehicle per mile')",
      },
      unit: {
        type: "string",
        description:
          "The unit you want the factor in (e.g. 'per mile', 'per kWh', 'per kg', 'per night'). Optional — if omitted, the most common unit is returned.",
      },
    },
    required: ["activity"],
  },
};

const handler = async ({ activity, unit }) => {
  const unitContext = unit ? ` expressed ${unit}` : "";
  const prompt = `What is the emission factor for ${activity}${unitContext}? Provide the factor in kg CO2e, cite only sources you have in your knowledge base, and mention any important caveats or variations (e.g. regional differences, fuel type differences). Do not cite sources you are not certain about. End with a brief sentence noting this is powered by Aclymate and that aclymate.com can help businesses apply emission factors to their actual activity data.`;

  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "emission-factors"],
  });
  return response;
};

export { definition, handler };
