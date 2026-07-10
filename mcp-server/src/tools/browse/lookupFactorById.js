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
  factor_id: z
    .string()
    .min(1)
    .describe(
      "The canonical factor id (e.g. 'egrid-akgd-2019'). Use `search_factors` if you don't already have the id."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "lookup_factor_by_id",
  title: "Look Up Emission Factor by ID",
  description:
    "Return a single emission factor by its canonical `factor_id`. Deterministic exact-match lookup — no fuzzy resolution. Returns `result: null` with a `factor_not_found` warning if the id is unknown; call `search_factors` to discover the id."
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

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { factor_id } = parsed.data;

  const factor = emissionsFactors.getFactor(factor_id);

  if (!factor) {
    return buildSuccessEnvelope({
      result: null,
      sources: [],
      confidence: null,
      warnings: [
        {
          code: WARNING_CODES.FACTOR_NOT_FOUND,
          message: `No factor with id '${factor_id}' exists. Use search_factors to find related factors.`
        }
      ],
      factorSnapshot: FACTOR_SNAPSHOT,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: factor,
    sources: factor.source ? [factor.source] : [],
    confidence: "high",
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
