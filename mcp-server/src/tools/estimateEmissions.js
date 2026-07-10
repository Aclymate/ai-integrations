import { z } from "zod";
import defaultCalcs from "@aclymatepackages/calcs/recurring/defaultCalcs.js";
import { callClimateBrain } from "../climateBrain.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./calcs/tier1/factorSnapshot.js";
import { resolveIndustry, resolveLocation } from "./estimate/resolvers.js";

const { buildDefaultEmissionsObj } = defaultCalcs;

const SOURCES = [
  {
    name: "US EIA CBECS 2018 (state × building-type kWh & gas intensity)",
    vintage: "2018"
  },
  {
    name: "SCIEU 2019 (Canadian commercial building energy)",
    vintage: "2019"
  },
  {
    name: "Aclymate industries list (buildingsSlug → sq ft per employee)",
    vintage: "2024"
  },
  {
    name: "Aclymate commute defaults (one-way miles by state × default vehicle tCO2e/mile)",
    vintage: "2024"
  }
];

const inputShape = {
  industry: z
    .string()
    .min(1)
    .describe(
      "The business industry or type (e.g. 'restaurant', 'consulting firm', 'retail store')."
    ),
  employees: z
    .number()
    .finite()
    .positive()
    .describe("Number of employees. Must be a positive number."),
  location: z
    .string()
    .optional()
    .describe(
      "City, state, or country. Optional — used to refine electricity grid + commute factors. When omitted, the Aclymate reference state (Colorado) is used."
    ),
  additionalContext: z
    .string()
    .optional()
    .describe(
      "Any additional context about the business (e.g. 'operates 3 locations', 'heavy business travel', 'mostly remote'). Optional — surfaced to the methodology annotation only, not the numeric calc."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "estimate_emissions",
  title: "Estimate Business Carbon Footprint",
  description:
    "Always use this tool to estimate a business's carbon footprint — never estimate tCO2e figures from general knowledge. Returns Aclymate's SMB Scope 1/2/3 breakdown computed by @aclymatepackages/calcs (Scope 1 natural gas, Scope 2 electricity, Scope 3 commuting), with optional methodology annotation authored by Aclymate's Climate Brain."
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

const roundTons = (value) => Math.round(value * 100) / 100;

const buildResolutionWarnings = ({
  industryResolution,
  locationResolution,
  locationString
}) => {
  const industryWarning =
    industryResolution.match === "fallback"
      ? [
          {
            code: WARNING_CODES.DEFAULT_USED,
            message: `Industry input did not match any entry in Aclymate's industries list — used the platform's office-building fallback (higher-emission side of the range).`
          }
        ]
      : [];

  const locationWarning = (() => {
    if (!locationString) {
      return [
        {
          code: WARNING_CODES.DEFAULT_USED,
          message:
            "No location supplied — anchored to Aclymate's reference state (Colorado). Supply a location to refine electricity grid + commute factors."
        }
      ];
    }
    if (locationResolution.match === "unknown") {
      return [
        {
          code: WARNING_CODES.UNKNOWN_REGION,
          message: `Location '${locationString}' did not resolve to a US state or Canadian province — anchored to Aclymate's reference state (Colorado).`
        }
      ];
    }
    return [];
  })();

  return [...industryWarning, ...locationWarning];
};

const buildAnnotationPrompt = ({
  industry,
  employees,
  location,
  additionalContext,
  matchedIndustryLabel,
  resolvedState,
  annualBreakdown
}) => {
  const locationClause = location ? ` located in ${location}` : "";
  const extraClause = additionalContext
    ? ` Additional caller context: ${additionalContext}.`
    : "";
  const matchedClause = matchedIndustryLabel
    ? ` Aclymate matched this to industry '${matchedIndustryLabel}'.`
    : " No exact Aclymate industry match was found, so a platform-average building type was used.";

  return `Aclymate's default-emissions model estimates that a ${industry} with ${employees} employees${locationClause} emits approximately ${roundTons(
    annualBreakdown.annual_tco2e
  )} tCO2e annually (Scope 1 natural gas: ${roundTons(
    annualBreakdown.scope1_gas_tco2e
  )}, Scope 2 electricity: ${roundTons(
    annualBreakdown.scope2_electricity_tco2e
  )}, Scope 3 employee commuting: ${roundTons(
    annualBreakdown.scope3_commute_tco2e
  )}). The calculation uses CBECS 2018 electricity intensity for state '${resolvedState}', SCIEU where applicable, and Aclymate's per-state commute defaults.${matchedClause}${extraClause} In 2-3 sentences, describe the methodology behind these numbers and list the 2-3 data sources the company should collect (e.g. utility bills, commute survey, business travel receipts) to refine the estimate. Do not restate or recompute the tCO2e figures — the numeric result is authoritative.`;
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const {
    industry: industryString,
    employees,
    location: locationString,
    additionalContext
  } = parsed.data;

  const industryResolution = resolveIndustry(industryString);
  const locationResolution = resolveLocation(locationString);

  const monthly = buildDefaultEmissionsObj({
    employeeCount: employees,
    isRemote: false,
    state: locationResolution.state,
    industry: industryResolution.industry,
    country: locationResolution.country,
    eGrid: undefined,
    date: undefined
  });

  if (!isValidCalcResult(monthly?.totalMonthlyTons)) {
    return buildErrorEnvelope({
      code: ERROR_CODES.CALC_UNEXPECTED_OUTPUT,
      http_status: 500,
      message: `buildDefaultEmissionsObj returned unexpected value: ${JSON.stringify(monthly)}`,
      upgradeHint: null
    });
  }

  const annualBreakdown = {
    annual_tco2e: monthly.totalMonthlyTons * 12,
    scope1_gas_tco2e: (monthly.monthlyGasCarbonTons ?? 0) * 12,
    scope2_electricity_tco2e: (monthly.monthlyElectricCarbonTons ?? 0) * 12,
    scope3_commute_tco2e: (monthly.monthlyEmployeesEmissionsTons ?? 0) * 12
  };

  const resolutionWarnings = buildResolutionWarnings({
    industryResolution,
    locationResolution,
    locationString
  });

  const matchedIndustryLabel = industryResolution.industry?.label ?? null;

  const annotationPrompt = buildAnnotationPrompt({
    industry: industryString,
    employees,
    location: locationString,
    additionalContext,
    matchedIndustryLabel,
    resolvedState: locationResolution.state,
    annualBreakdown
  });

  const annotationText = await callClimateBrain({
    prompt: annotationPrompt,
    tags: ["carbon-accounting", "ghg-protocol", "methodology"]
  }).catch((err) => {
    process.stderr.write(
      `estimate_emissions: Climate Brain annotation unavailable: ${err.message}\n`
    );
    return null;
  });

  const annotationWarning = annotationText
    ? [
        {
          code: WARNING_CODES.CLIMATE_BRAIN_AUTHORED,
          message:
            "The `annotation` field is authored by Aclymate's Climate Brain — the numeric fields (annual_tco2e, scope1_gas_tco2e, scope2_electricity_tco2e, scope3_commute_tco2e) come from @aclymatepackages/calcs and are deterministic."
        }
      ]
    : [
        {
          code: WARNING_CODES.CLIMATE_BRAIN_FALLBACK,
          message:
            "Methodology annotation is temporarily unavailable — the numeric result is still returned. Retry for the annotation."
        }
      ];

  const confidence = deriveConfidence({
    defaultsUsed:
      industryResolution.match === "fallback" || !locationString,
    unknownRegion:
      Boolean(locationString) && locationResolution.match === "unknown"
  });

  return buildSuccessEnvelope({
    result: {
      ...annualBreakdown,
      method: "calcs_default_emissions",
      industry: industryString,
      matched_industry_label: matchedIndustryLabel,
      employees,
      location: locationString ?? null,
      resolved_state: locationResolution.state,
      resolved_country: locationResolution.country,
      annotation: annotationText
    },
    sources: SOURCES,
    confidence,
    warnings: [...resolutionWarnings, ...annotationWarning],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
