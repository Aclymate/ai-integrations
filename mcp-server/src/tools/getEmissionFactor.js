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
import { convertValueUnit } from "./unitConversion.js";

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
      "Convert the factor's denominator to a different unit in the same dimension — distance (e.g. 'per mile' <-> 'per km'), energy ('per kWh' <-> 'per MWh' <-> 'per GWh'), or mass ('per kg' <-> 'per lb'). Optional — if omitted, or if the requested unit isn't a same-dimension match for this factor (e.g. asking a per-gallon fuel factor for 'per mile'), the catalog's native unit is returned instead, with a warning in that second case."
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

// Merges per-key conversion outcomes into one status for the whole value block: if any
// key couldn't be converted, the caller must warn (never silently return a partial
// conversion as if the whole request succeeded); "converted" only when every attempted
// key actually changed; "already_native" when every key was already the requested unit.
const mergeConversionStatuses = (statuses) => {
  if (statuses.some((s) => s === "incompatible")) return "incompatible";
  if (statuses.some((s) => s === "converted")) return "converted";
  if (statuses.every((s) => s === "already_native")) return "already_native";
  return "incompatible";
};

const buildValueBlock = (match, requestedUnit) => {
  if (typeof match.value === "number" && match.units) {
    if (!requestedUnit) return { block: { value: match.value, units: match.units }, conversionStatus: null };
    const result = convertValueUnit(match.value, match.units, requestedUnit);
    if (result.status === "converted") {
      return { block: { value: result.value, units: result.unit }, conversionStatus: "converted" };
    }
    return { block: { value: match.value, units: match.units }, conversionStatus: result.status };
  }
  if (match.values && typeof match.values === "object") {
    if (!requestedUnit) {
      return { block: { values: match.values, units: match.units ?? null }, conversionStatus: null };
    }
    const values = {};
    const units = {};
    const statuses = [];
    Object.entries(match.values).forEach(([key, value]) => {
      const unitStr = match.units?.[key];
      const result = convertValueUnit(value, unitStr, requestedUnit);
      statuses.push(result.status);
      if (result.status === "converted") {
        values[key] = result.value;
        units[key] = result.unit;
      } else {
        values[key] = value;
        units[key] = unitStr;
      }
    });
    return { block: { values, units }, conversionStatus: mergeConversionStatuses(statuses) };
  }
  return { block: { value: null, units: match.units ?? null }, conversionStatus: null };
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

const buildCanonicalHitEnvelope = ({
  match,
  disambiguation_hint,
  activity,
  usedFuzzyMatch,
  requestedUnit
}) => {
  const disambiguationList =
    disambiguation_hint && disambiguation_hint.length > 0
      ? disambiguation_hint
      : null;
  const { block: valueBlock, conversionStatus } = buildValueBlock(match, requestedUnit);
  const warnings = [];
  if (usedFuzzyMatch) {
    warnings.push({
      code: WARNING_CODES.FUZZY_MATCH,
      message: `No exact match for '${activity}' — matched '${match.factor_id}' via fuzzy token overlap instead. Verify this is the intended factor.`
    });
  }
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
  if (conversionStatus === "incompatible") {
    warnings.push({
      code: WARNING_CODES.UNIT_NOT_CONVERTIBLE,
      message: `Requested unit '${requestedUnit}' isn't a supported conversion for '${match.factor_id}' — returning the catalog's native unit instead. Only same-dimension conversions (distance, energy, or mass) are supported; this factor's denominator can't be safely converted to what you asked for.`
    });
  }
  const confidence = isEmptyValueBlock(match)
    ? "low"
    : usedFuzzyMatch
      ? "medium"
      : "high";
  return buildSuccessEnvelope({
    result: {
      factor_id: match.factor_id,
      factor_type: match.factor_type,
      activity,
      value_block: valueBlock,
      source_block: buildSourceBlock(match.source),
      disambiguation_hint: disambiguationList
    },
    sources: match.source ? [match.source] : [],
    confidence,
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
      activity,
      usedFuzzyMatch: Boolean(lookupResult.used_fuzzy_match),
      requestedUnit: unit
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
