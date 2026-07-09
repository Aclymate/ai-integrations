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

const inputShape = {
  factor_type: z
    .string()
    .min(1)
    .describe(
      "The canonical factor type to enumerate (e.g. 'egrid', 'flight'). Call `list_factor_types` if unknown."
    ),
  key_name: z
    .string()
    .optional()
    .describe(
      "Optional — the specific key to enumerate values for (e.g. 'egrid_region'). Omit to use the factor_type's designated drill key."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "list_factor_key_values",
  title: "List Emission Factor Key Values",
  description:
    "Enumerate the distinct values available for a given `key_name` under a `factor_type` (e.g. every eGRID region, every fuel type). Omitting `key_name` falls back to the factor_type's designated drill key with a `drill_key_defaulted` warning. Use before `find_factor` when drilling into a category."
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

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { factor_type, key_name } = parsed.data;

  const knownTypes = new Set(emissionsFactors.listFactorTypes());
  if (!knownTypes.has(factor_type)) {
    return buildSuccessEnvelope({
      result: { factor_type, key_name: null, values: [] },
      sources: [],
      confidence: null,
      warnings: [
        {
          code: WARNING_CODES.UNKNOWN_FACTOR_TYPE,
          message: `'${factor_type}' is not a known factor type. Call list_factor_types to see valid types.`
        }
      ],
      factorSnapshot: FACTOR_SNAPSHOT,
      upgradeHint: null
    });
  }

  const drillKey = emissionsFactors.getDrillKey(factor_type);

  if (!key_name && !drillKey) {
    return buildSuccessEnvelope({
      result: { factor_type, key_name: null, values: [] },
      sources: [],
      confidence: null,
      warnings: [
        {
          code: WARNING_CODES.NO_DRILL_KEY_AVAILABLE,
          message: `factor_type '${factor_type}' has no designated drill key. Supply a key_name explicitly or call find_factor to enumerate.`
        }
      ],
      factorSnapshot: FACTOR_SNAPSHOT,
      upgradeHint: null
    });
  }

  const effectiveKeyName = key_name || drillKey;
  const values = emissionsFactors.listFactorKeyValues(
    factor_type,
    effectiveKeyName
  );

  const warnings = !key_name
    ? [
        {
          code: WARNING_CODES.DRILL_KEY_DEFAULTED,
          message: `key_name omitted — used '${effectiveKeyName}' (drill key for '${factor_type}').`
        }
      ]
    : [];

  return buildSuccessEnvelope({
    result: {
      factor_type,
      key_name: effectiveKeyName,
      values
    },
    sources: [],
    confidence: "high",
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
