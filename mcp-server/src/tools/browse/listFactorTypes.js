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

const inputShape = {};

const zodSchema = z.object(inputShape);

const definition = {
  name: "list_factor_types",
  title: "List Emission Factor Types",
  description:
    "List every emission factor type in Aclymate's canonical catalog (e.g. `egrid`, `flight`, `fuel`, `ceda_sector`). Use before `find_factor` when the caller needs to enumerate categories before drilling in. Returns the full sorted list — no truncation."
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

  const factorTypes = emissionsFactors.listFactorTypes();
  const warnings =
    factorTypes.length === 0
      ? [
          {
            code: WARNING_CODES.MANIFEST_UNAVAILABLE,
            message:
              "Emissions-factors manifest is empty — no factor types available."
          }
        ]
      : [];

  return buildSuccessEnvelope({
    result: {
      factor_types: factorTypes
    },
    sources: [],
    confidence: factorTypes.length === 0 ? null : "high",
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
