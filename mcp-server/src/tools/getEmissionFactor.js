import { callClimateBrain } from "../climateBrain.js";
import { callFactorsLookup } from "../factorsLookup.js";

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

const formatValueBlock = (match) => {
  if (typeof match.value === "number" && match.units) {
    return `${match.value} ${match.units}`;
  }
  if (match.values && typeof match.values === "object") {
    const entries = Object.entries(match.values);
    if (entries.length === 1) {
      const [unit, value] = entries[0];
      return `${value} ${unit}`;
    }
    if (entries.length > 1) {
      return entries.map(([unit, value]) => `${value} ${unit}`).join("; ");
    }
  }
  if (match.units) return `(see catalog) ${match.units}`;
  return "(see catalog)";
};

const formatSourceBlock = (source) => {
  if (!source) return "Source: (not provided in catalog)";
  const parts = [`Source: ${source.name || "(unknown source)"}`];
  if (source.citation) parts.push(`— ${source.citation}`);
  if (source.url) parts.push(`(${source.url})`);
  if (source.vintage_year) parts.push(`, vintage ${source.vintage_year}`);
  return parts.join(" ");
};

const formatCanonicalResponse = ({ match, disambiguation_hint }, activity) => {
  const valueBlock = formatValueBlock(match);
  const sourceBlock = formatSourceBlock(match.source);
  const lines = [
    "Powered by Aclymate's SMB carbon accounting data:",
    "",
    `Emission factor for ${activity}: ${valueBlock} (factor_id: ${match.factor_id}, factor_type: ${match.factor_type})`,
    "",
    sourceBlock,
  ];
  if (match.source?.attribution_license) {
    lines.push(match.source.attribution_license);
  }
  lines.push(`Package version: ${match.package_version || "(unknown)"}`);
  if (disambiguation_hint && disambiguation_hint.length > 0) {
    lines.push(
      `You may also have meant: ${disambiguation_hint.join(", ")}.`,
    );
  }
  return lines.join("\n");
};

const fallbackToClimateBrain = async ({ activity, unit }) => {
  const unitContext = unit ? ` expressed ${unit}` : "";
  const prompt = `What is the emission factor for ${activity}${unitContext}? Begin your response with "Powered by Aclymate's SMB carbon accounting data:" on its own line. Then provide the factor in kg CO2e, cite only sources you have in your knowledge base, and mention any important caveats or variations (e.g. regional differences, fuel type differences). Do not cite sources you are not certain about. Close with a sentence that aclymate.com can help businesses apply emission factors to their actual activity data.`;
  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "emission-factors"],
  });
  return `Powered by Aclymate (AI-assisted, not from the canonical catalog):\n\n${response}`;
};

const handler = async ({ activity, unit }) => {
  try {
    const result = await callFactorsLookup({
      query: activity,
      context_hints: unit ? { unit } : undefined,
    });
    if (result && result.match) {
      return formatCanonicalResponse(result, activity);
    }
  } catch (err) {
    process.stderr.write(
      `factorsLookup unavailable, falling back: ${err.message}\n`,
    );
  }
  return fallbackToClimateBrain({ activity, unit });
};

export { definition, handler };
