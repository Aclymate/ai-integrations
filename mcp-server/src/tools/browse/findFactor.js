import { z } from "zod";
import { createRequire } from "node:module";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../../responseEnvelope.js";
import { FACTOR_SNAPSHOT } from "./factorSnapshot.js";

const require_ = createRequire(import.meta.url);
const emissionsFactors = require_("@aclymatepackages/emissions-factors");

const MAX_INLINE_TYPES = 15;

const inputShape = {
  factor_type: z
    .string()
    .min(1)
    .describe(
      "The canonical factor type (e.g. 'egrid', 'flight', 'fuel'). Call `list_factor_types` to enumerate."
    ),
  keys: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Key/value map used to pin down the exact factor (e.g. `{egrid_region: 'AKGD', vintage_year: 2019}`). At least one key is required. Call `list_factor_key_values` to enumerate valid keys and values."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "find_factor",
  title: "Find Emission Factor by Keys",
  description:
    "Return the first emission factor matching a `factor_type` + `keys` combination. Deterministic keyed lookup — assertion mode, no fuzzy fallbacks. Empty keys, unknown key names, or no-match all return `result: null` with a descriptive warning. Use `list_factor_key_values` to discover valid keys; use `search_factors` for keyword search."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: ERROR_CODES.INVALID_INPUT,
    http_status: 400,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    upgradeHint: null
  });

const summarizeTypeList = () => {
  const all = emissionsFactors.listFactorTypes();
  if (all.length <= MAX_INLINE_TYPES) return all.join(", ");
  const shown = all.slice(0, MAX_INLINE_TYPES).join(", ");
  return `${shown}, …and ${all.length - MAX_INLINE_TYPES} more`;
};

const collectValidKeyNames = (factorType) => {
  const sample = emissionsFactors
    .listFactorsByType(factorType)
    .slice(0, 200);
  const names = sample.reduce((acc, factor) => {
    Object.keys(factor.keys || {}).forEach((name) => acc.add(name));
    return acc;
  }, new Set());
  return [...names].sort();
};

const buildNullEnvelope = ({ warnings }) =>
  buildSuccessEnvelope({
    result: null,
    sources: [],
    confidence: null,
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { factor_type, keys } = parsed.data;

  const knownTypes = new Set(emissionsFactors.listFactorTypes());
  if (!knownTypes.has(factor_type)) {
    return buildNullEnvelope({
      warnings: [
        {
          code: WARNING_CODES.UNKNOWN_FACTOR_TYPE,
          message: `'${factor_type}' is not a known factor type. Known types: [${summarizeTypeList()}]. Call list_factor_types to see them all.`
        }
      ]
    });
  }

  const hasKeys = keys && Object.keys(keys).length > 0;
  if (!hasKeys) {
    const validKeys = collectValidKeyNames(factor_type);
    return buildNullEnvelope({
      warnings: [
        {
          code: WARNING_CODES.NO_KEYS_SUPPLIED,
          message: `No keys supplied for factor_type '${factor_type}'. This tool requires at least one key to identify a specific factor. Valid keys: [${validKeys.join(", ")}]. Call list_factor_key_values(factor_type: '${factor_type}') to see valid values, then retry.`
        }
      ]
    });
  }

  const validKeyNames = new Set(collectValidKeyNames(factor_type));
  const badKey = Object.keys(keys).find((name) => !validKeyNames.has(name));
  if (badKey) {
    return buildNullEnvelope({
      warnings: [
        {
          code: WARNING_CODES.UNKNOWN_KEY_NAME,
          message: `Key '${badKey}' is not valid on factor_type '${factor_type}'. Valid keys: [${[...validKeyNames].sort().join(", ")}]. Retry with the correct key name.`
        }
      ]
    });
  }

  const match = emissionsFactors.findFactor(factor_type, keys);

  if (!match) {
    return buildNullEnvelope({
      warnings: [
        {
          code: WARNING_CODES.NO_MATCH_FOR_KEYS,
          message: `No factor of type '${factor_type}' matches the supplied keys. Try broader keys or call list_factor_key_values to see valid values.`
        }
      ]
    });
  }

  return buildSuccessEnvelope({
    result: match,
    sources: match.source ? [match.source] : [],
    confidence: "high",
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
