import { callClimateBrain } from "../climateBrain.js";

const definition = {
  name: "get_emission_factor",
  description:
    "Returns the emission factor for a specific activity — the kg CO2e per unit of that activity. Includes the source and any important caveats. Powered by Aclymate.",
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
  const prompt = `What is the emission factor for ${activity}${unitContext}? Provide the factor in kg CO2e, note the source (EPA, IPCC, DEFRA, etc.), and mention any important caveats or variations (e.g. regional differences, fuel type differences).`;

  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "emission-factors"],
  });
  return response;
};

export { definition, handler };
