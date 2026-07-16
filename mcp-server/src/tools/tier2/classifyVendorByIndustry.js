import { z } from "zod";
import calcs from "@aclymatepackages/calcs/vendors/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, deriveConfidence } from "./factorSnapshot.js";

const { findVendorEmissionCategoryData } = calcs;

const SOURCES = [
  {
    name: "Aclymate spend-based emissions factors (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  vendorName: z
    .string()
    .min(1)
    .describe(
      "The vendor's business name, as supplied by the caller. Stored verbatim on the result — this is the user's own data in their own account."
    ),
  industryHint: z
    .string()
    .optional()
    .describe(
      "The vendor's NAICS industry label if known (e.g. 'Software Publishers'). Improves classification accuracy — omit if unknown."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "classify_vendor_by_industry",
  title: "Classify Vendor By Industry",
  description:
    "Classify a vendor into an emissions category (spend-based NAICS classification) using Aclymate's industry data. Pass `industryHint` (a NAICS industry label) if you know it — this materially improves accuracy. Result is saved to the caller's Explorer dashboard."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: "invalid_input",
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
  const { vendorName, industryHint } = parsed.data;

  const categoryData = findVendorEmissionCategoryData({
    industry: industryHint ? { label: industryHint } : undefined
  });

  const hasIndustryMatch = categoryData?.tonsCo2ePerDollar != null;

  const warnings = hasIndustryMatch
    ? []
    : [
        {
          code: "no_industry_match",
          message: industryHint
            ? `No NAICS match found for industryHint "${industryHint}" — returning an unclassified result.`
            : "No industryHint supplied — returning an unclassified result."
        }
      ];

  const confidence = deriveConfidence({ unknownRegion: !hasIndustryMatch });

  return buildSuccessEnvelope({
    result: {
      vendorName,
      emissionCategory: categoryData?.emissionCategory ?? null,
      naicsCode: categoryData?.naicsCode ?? null,
      naicsTitle: categoryData?.naicsTitle ?? null,
      scopeThreeCategory: categoryData?.scopeThreeCategory ?? null,
      tonsCo2ePerDollar: categoryData?.tonsCo2ePerDollar ?? null
    },
    sources: SOURCES,
    confidence,
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
