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
      "The vendor's industry as a plain-language label matching Aclymate's internal taxonomy (e.g. 'Computer Software / Engineering', 'Restaurants') — NOT an official NAICS title ('Software Publishers' will not match). Prefer `naicsCode` when you have it; it matches exactly."
    ),
  naicsCode: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "The vendor's 6-digit NAICS code if known (e.g. 511210). Matched exactly, unlike `industryHint` — use this when you have an official NAICS classification rather than guessing a label."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "classify_vendor_by_industry",
  title: "Classify Vendor By Industry",
  description:
    "Classify a vendor into an emissions category (spend-based NAICS classification) using Aclymate's industry data. Pass `naicsCode` if you know the vendor's NAICS code — it's an exact match. Otherwise pass `industryHint` as a plain-language industry description; official NAICS titles will NOT match it, use `naicsCode` for those instead. Result is saved to the caller's Explorer dashboard."
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
  const { vendorName, industryHint, naicsCode } = parsed.data;

  const categoryData = findVendorEmissionCategoryData({
    industry:
      naicsCode || industryHint ? { label: industryHint, naicsCode } : undefined
  });

  const hasIndustryMatch = categoryData?.tonsCo2ePerDollar != null;

  const describeAttempt = () => {
    if (naicsCode) {
      return `naicsCode "${naicsCode}"`;
    }
    if (industryHint) {
      return `industryHint "${industryHint}"`;
    }
    return null;
  };

  const warnings = hasIndustryMatch
    ? []
    : [
        {
          code: "no_industry_match",
          message: describeAttempt()
            ? `No match found for ${describeAttempt()} — returning an unclassified result.`
            : "No industryHint or naicsCode supplied — returning an unclassified result."
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
