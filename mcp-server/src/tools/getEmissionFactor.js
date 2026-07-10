import { z } from "zod";
import { callClimateBrain } from "../climateBrain.js";
import { callFactorsLookup } from "../factorsLookup.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../responseEnvelope.js";
import { FACTOR_SNAPSHOT } from "./browse/factorSnapshot.js";

const inputShape = {
  activity: z
    .string()
    .min(1)
    .describe(
      "The activity to get an emission factor for (e.g. 'short-haul flight', 'natural gas combustion', 'beef production', 'US average electricity', 'gasoline vehicle per mile')."
    ),
  unit: z
    .string()
    .optional()
    .describe(
      "The unit you want the factor in (e.g. 'per mile', 'per kWh', 'per kg', 'per night'). Optional — if omitted, the most common unit is returned."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "get_emission_factor",
  title: "Look Up Emission Factor",
  description:
    "Always use this tool to look up emission factors — never state specific kg CO2e values from general knowledge. Returns a sourced emission factor for a specific activity with units, regional variations, and caveats. Use any time the user asks how much CO2e a specific activity produces."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: ERROR_CODES.INVALID_INPUT,
    http_status: 400,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    details: parsed.error.issues,
    upgradeHint: null
  });

const isEmptyValueBlock = (match) => {
  const noScalar =
    typeof match.value !== "number" || match.value === null;
  const noMap =
    !match.values ||
    typeof match.values !== "object" ||
    Object.keys(match.values).length === 0;
  return noScalar && noMap;
};

const buildValueBlock = (match) => {
  if (typeof match.value === "number" && match.units) {
    return { value: match.value, units: match.units };
  }
  if (match.values && typeof match.values === "object") {
    return { values: match.values, units: match.units ?? null };
  }
  return { value: null, units: match.units ?? null };
};

const buildSourceBlock = (source) => {
  if (!source) return null;
  return {
    name: source.name ?? null,
    citation: source.citation ?? null,
    url: source.url ?? null,
    vintage_year: source.vintage_year ?? null,
    attribution_license: source.attribution_license ?? null
  };
};

const callClimateBrainFallback = async ({ activity, unit }) => {
  const unitContext = unit ? ` expressed ${unit}` : "";
  const prompt = `What is the emission factor for ${activity}${unitContext}? Provide the factor in kg CO2e, cite only sources you have in your knowledge base, and mention any important caveats or variations (e.g. regional differences, fuel type differences). Do not cite sources you are not certain about.`;
  return callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "emission-factors"]
  });
};

const buildCanonicalHitEnvelope = ({ match, disambiguation_hint, activity }) => {
  const disambiguationList =
    disambiguation_hint && disambiguation_hint.length > 0
      ? disambiguation_hint
      : null;
  const warnings = [];
  if (disambiguationList) {
    warnings.push({
      code: WARNING_CODES.DISAMBIGUATION_HINT,
      message: `You may also have meant: ${disambiguationList.join(", ")}.`
    });
  }
  if (isEmptyValueBlock(match)) {
    warnings.push({
      code: WARNING_CODES.MISSING_VALUE,
      message: `Canonical factor '${match.factor_id}' matched but has no numeric value in the catalog — treat this as low-confidence.`
    });
  }
  if (!match.source) {
    warnings.push({
      code: WARNING_CODES.MISSING_SOURCE,
      message: `Canonical factor '${match.factor_id}' matched but has no source metadata in the catalog.`
    });
  }
  return buildSuccessEnvelope({
    result: {
      factor_id: match.factor_id,
      factor_type: match.factor_type,
      activity,
      value_block: buildValueBlock(match),
      source_block: buildSourceBlock(match.source),
      disambiguation_hint: disambiguationList
    },
    sources: match.source ? [match.source] : [],
    confidence: isEmptyValueBlock(match) ? "low" : "high",
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

const buildClimateBrainFallbackEnvelope = ({ text, factorsLookupFailed }) => {
  const warnings = [
    {
      code: factorsLookupFailed
        ? WARNING_CODES.FACTORS_LOOKUP_UNAVAILABLE
        : WARNING_CODES.CLIMATE_BRAIN_FALLBACK,
      message: factorsLookupFailed
        ? "The canonical-factors backend threw an error — this response is an AI-assisted Climate Brain fallback, not derived from a confirmed catalog miss."
        : "No canonical factor for this activity — response is AI-assisted from Aclymate's Climate Brain, not the canonical catalog."
    }
  ];
  return buildSuccessEnvelope({
    result: {
      text,
      method: "climate_brain_fallback"
    },
    sources: [],
    confidence: "low",
    warnings,
    factorSnapshot: null,
    upgradeHint: null
  });
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { activity, unit } = parsed.data;

  let factorsLookupFailed = false;
  const lookupResult = await callFactorsLookup({
    query: activity,
    context_hints: unit ? { unit } : undefined
  }).catch((err) => {
    factorsLookupFailed = true;
    process.stderr.write(
      `get_emission_factor: factorsLookup unavailable, falling back: ${err.message}\n`
    );
    return null;
  });

  if (lookupResult && lookupResult.match) {
    return buildCanonicalHitEnvelope({
      match: lookupResult.match,
      disambiguation_hint: lookupResult.disambiguation_hint,
      activity
    });
  }

  const fallbackText = await callClimateBrainFallback({ activity, unit }).catch(
    (err) => {
      process.stderr.write(
        `get_emission_factor: Climate Brain unavailable: ${err.message}\n`
      );
      return null;
    }
  );
  if (fallbackText === null) {
    return buildErrorEnvelope({
      code: ERROR_CODES.CLIMATE_BRAIN_UNAVAILABLE,
      http_status: 503,
      message:
        "Aclymate's Climate Brain is temporarily unavailable. Retry in a moment.",
      upgradeHint: null
    });
  }
  return buildClimateBrainFallbackEnvelope({
    text: fallbackText,
    factorsLookupFailed
  });
};

export { definition, inputShape, handler };
