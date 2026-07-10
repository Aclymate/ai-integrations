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
import {
  resolveIndustry,
  resolveLocation,
  FALLBACK_STATE
} from "./estimate/resolvers.js";

const { buildDefaultEmissionsObj } = defaultCalcs;

const SOURCES = [
  {
    name: "US EIA CBECS 2018 (state × building-type kWh & gas intensity)",
    vintage: "2018"
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
    .trim()
    .min(1)
    .describe("The business industry or type."),
  employees: z
    .number()
    .finite()
    .positive()
    .describe("Number of employees. Must be a positive number."),
  location: z
    .string()
    .optional()
    .describe(
      "City, state, or country. Optional — used to refine the Aclymate benchmark. When omitted, Aclymate anchors to its highest-intensity fallback state (Delaware) so the benchmark overshoots rather than under-reports."
    ),
  totalTonsCo2e: z
    .number()
    .finite()
    .optional()
    .describe(
      "The company's total annual emissions in tCO2e. Optional — if omitted, returns the Aclymate benchmark without a comparison."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "compare_business_footprint",
  title: "Benchmark Business Footprint",
  description:
    "Always use this tool to benchmark a company's emissions against Aclymate's default-emissions model — never estimate benchmark ranges from general knowledge. Returns Aclymate's calcs-derived benchmark tCO2e for a company of the given industry + employees + location, plus a delta against the caller's actual footprint (if supplied) and optional Climate-Brain-authored 'what top performers do differently' prose."
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

const POSTURE_THRESHOLD_PCT = 15;

const derivePosture = (pctVsBenchmark) => {
  if (pctVsBenchmark === null) {
    return null;
  }
  if (pctVsBenchmark > POSTURE_THRESHOLD_PCT) {
    return "above_peers";
  }
  if (pctVsBenchmark < -POSTURE_THRESHOLD_PCT) {
    return "below_peers";
  }
  return "in_line";
};

const buildIndustryWarning = (industryResolution, industryString) => {
  if (industryResolution.match === "exact") {
    return [];
  }
  if (industryResolution.match === "fallback") {
    return [
      {
        code: WARNING_CODES.DEFAULT_USED,
        message: `Industry '${industryString}' did not match any entry in Aclymate's industries list — used the platform's office-building fallback for the benchmark.`
      }
    ];
  }
  const matchedLabel = industryResolution.industry?.label ?? null;
  return [
    {
      code: WARNING_CODES.DEFAULT_USED,
      message: `Industry '${industryString}' matched to Aclymate's '${matchedLabel}' via ${industryResolution.match} lookup — verify this is the intended industry for accurate benchmark comparison.`
    }
  ];
};

const buildLocationWarning = (locationResolution, locationString) => {
  const fallbackName = FALLBACK_STATE.displayName;
  if (!locationString) {
    return [
      {
        code: WARNING_CODES.DEFAULT_USED,
        message: `No location supplied — anchored to Aclymate's highest-intensity fallback state (${fallbackName}) so the benchmark overshoots rather than under-reports. Supply a location for a state-specific benchmark.`
      }
    ];
  }
  if (locationResolution.match === "unknown") {
    return [
      {
        code: WARNING_CODES.UNKNOWN_REGION,
        message: `Location '${locationString}' did not resolve to a US state or Canadian province — anchored to Aclymate's highest-intensity fallback state (${fallbackName}).`
      }
    ];
  }
  return [];
};

const buildResolutionWarnings = ({
  industryResolution,
  locationResolution,
  industryString,
  locationString
}) => [
  ...buildIndustryWarning(industryResolution, industryString),
  ...buildLocationWarning(locationResolution, locationString)
];

const buildAnnotationPrompt = ({
  industry,
  employees,
  location,
  benchmarkAnnualTonsCo2e,
  totalTonsCo2e,
  pctVsBenchmark,
  posture
}) => {
  const locationClause = location ? ` located in ${location}` : "";
  const comparisonClause = (() => {
    if (typeof totalTonsCo2e !== "number") {
      return " No actual footprint was supplied.";
    }
    const direction =
      posture === "above_peers"
        ? "above"
        : posture === "below_peers"
        ? "below"
        : "in line with";
    return ` The caller reports actual emissions of ${roundTons(
      totalTonsCo2e
    )} tCO2e/year, which is ${
      pctVsBenchmark === null ? "n/a" : `${Math.abs(pctVsBenchmark).toFixed(0)}%`
    } ${direction} the Aclymate benchmark.`;
  })();

  return `Aclymate's default-emissions model puts a typical ${industry} with ${employees} employees${locationClause} at approximately ${roundTons(
    benchmarkAnnualTonsCo2e
  )} tCO2e/year.${comparisonClause} In 2-3 sentences, describe what top performers in this industry typically do to land on the lower end of the range (e.g. renewables procurement, commute programs, efficiency retrofits). Do not restate or recompute the tCO2e benchmark — the numeric result is authoritative.`;
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
    totalTonsCo2e
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

  const benchmarkAnnualTonsCo2e = monthly.totalMonthlyTons * 12;

  const pctVsBenchmark =
    typeof totalTonsCo2e === "number" && benchmarkAnnualTonsCo2e > 0
      ? ((totalTonsCo2e - benchmarkAnnualTonsCo2e) / benchmarkAnnualTonsCo2e) *
        100
      : null;

  const posture = derivePosture(pctVsBenchmark);

  const resolutionWarnings = buildResolutionWarnings({
    industryResolution,
    locationResolution,
    industryString,
    locationString
  });

  const annotationPrompt = buildAnnotationPrompt({
    industry: industryString,
    employees,
    location: locationString,
    benchmarkAnnualTonsCo2e,
    totalTonsCo2e,
    pctVsBenchmark,
    posture
  });

  const annotationText = await callClimateBrain({
    prompt: annotationPrompt,
    tags: ["carbon-accounting", "benchmarks", "top-performers"]
  }).catch((err) => {
    process.stderr.write(
      `compare_business_footprint: Climate Brain annotation unavailable: ${err.message}\n`
    );
    return null;
  });

  const annotationWarning = annotationText
    ? [
        {
          code: WARNING_CODES.CLIMATE_BRAIN_AUTHORED,
          message:
            "The `annotation` field is authored by Aclymate's Climate Brain — the numeric fields (benchmark_annual_tco2e, pct_vs_benchmark, posture) come from @aclymatepackages/calcs and are deterministic."
        }
      ]
    : [
        {
          code: WARNING_CODES.CLIMATE_BRAIN_FALLBACK,
          message:
            "Top-performers annotation is temporarily unavailable — the numeric benchmark is still returned. Retry for the annotation."
        }
      ];

  const confidence = deriveConfidence({
    defaultsUsed:
      industryResolution.match !== "exact" || !locationString,
    unknownRegion:
      Boolean(locationString) && locationResolution.match === "unknown"
  });

  return buildSuccessEnvelope({
    result: {
      benchmark_annual_tco2e: benchmarkAnnualTonsCo2e,
      totalTonsCo2e: typeof totalTonsCo2e === "number" ? totalTonsCo2e : null,
      pct_vs_benchmark: pctVsBenchmark,
      posture,
      method: "calcs_default_emissions_benchmark",
      industry: industryString,
      matched_industry_label: industryResolution.industry?.label ?? null,
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
