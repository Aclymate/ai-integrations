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

const SEARCH_CAP = 25;

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "A keyword or short phrase — matched against factor ids, categories, aliases, and search terms."
    ),
  factor_type: z
    .string()
    .optional()
    .describe(
      "Optional — scope the search to a single factor type (e.g. 'egrid'). Omit to search across every type."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "search_factors",
  title: "Search Emission Factors",
  description:
    "Keyword search across the canonical factor catalog — matches ids, categories, aliases, and search terms. Returns up to 25 hits; a `result_truncated` warning tells you the true total. Empty results return an empty list plus a warning, never an error. Use when the caller doesn't know a factor_id or key vocabulary yet."
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

const dedupeByFactorId = (factors) => {
  const seen = new Set();
  return factors.reduce((acc, factor) => {
    if (seen.has(factor.factor_id)) return acc;
    seen.add(factor.factor_id);
    return [...acc, factor];
  }, []);
};

const searchAllTypes = (query) => {
  const byAlias = emissionsFactors.findFactorsByAlias(query);
  const bySearchTerm = emissionsFactors.findFactorsBySearchTerm(query);
  return dedupeByFactorId([...byAlias, ...bySearchTerm]);
};

const searchWithinType = (factorType, query) =>
  emissionsFactors.listFactorsByType(factorType, { search: query });

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { query, factor_type } = parsed.data;

  if (factor_type) {
    const knownTypes = new Set(emissionsFactors.listFactorTypes());
    if (!knownTypes.has(factor_type)) {
      return buildSuccessEnvelope({
        result: { factors: [], count: 0 },
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
  }

  const matches = factor_type
    ? searchWithinType(factor_type, query)
    : searchAllTypes(query);

  if (matches.length === 0) {
    return buildSuccessEnvelope({
      result: { factors: [], count: 0 },
      sources: [],
      confidence: null,
      warnings: [
        {
          code: WARNING_CODES.NO_SEARCH_MATCHES,
          message: `No factors matched query '${query}'${factor_type ? ` within factor_type '${factor_type}'` : ""}. Try a broader term or call list_factor_types to browse categories.`
        }
      ],
      factorSnapshot: FACTOR_SNAPSHOT,
      upgradeHint: null
    });
  }

  const truncated = matches.length > SEARCH_CAP;
  const trimmed = truncated ? matches.slice(0, SEARCH_CAP) : matches;
  const warnings = truncated
    ? [
        {
          code: WARNING_CODES.RESULT_TRUNCATED,
          message: `Showing ${SEARCH_CAP} of ${matches.length} matches. Narrow with factor_type or a more specific query.`
        }
      ]
    : [];

  return buildSuccessEnvelope({
    result: {
      factors: trimmed,
      count: matches.length
    },
    sources: [],
    confidence: "high",
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
