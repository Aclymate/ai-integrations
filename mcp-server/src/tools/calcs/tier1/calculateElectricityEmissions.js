import { z } from "zod";
import calcs from "@aclymatepackages/calcs/utilities/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const {
  calcElectricEmissionsPerUnitValue,
  findCarbonTonsPerMwh,
  classifyEGrid,
  resolveEGridDataYear
} = calcs;

const SOURCES = [
  {
    name: "EPA eGRID Total Output Emission Factors + Environment Canada + IEA global average (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  unitValue: z
    .number()
    .finite()
    .positive()
    .describe("How much electricity — a positive number."),
  unit: z
    .enum(["kwh", "mwh"])
    .describe("Unit of the value. Only `kwh` and `mwh` are accepted."),
  eGrid: z
    .string()
    .optional()
    .describe(
      "US eGRID subregion code, Canadian province, or country. If omitted, defaults to MROE — the upper-bound US subregion (a conservative estimator, not a locale-specific default)."
    ),
  date: z
    .string()
    .optional()
    .describe(
      "Optional ISO date (YYYY-MM-DD or ISO datetime). Used to pick the data-year — the calc walks down to the closest available data year. Pass this only when the user explicitly names a year."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_electricity_emissions",
  title: "Calculate Electricity Emissions",
  description:
    "Calculate tCO2e for electricity usage using EPA eGRID (US), Environment Canada province factors, or the IEA global average. Requires `unitValue` and `unit` (`kwh` or `mwh`). Optional `eGrid` accepts a US eGRID subregion code (e.g. `CAMX`, `NYCW`), a Canadian province name, or a country name. If omitted, uses MROE — the highest-intensity US subregion, deliberately conservative. Optional `date` (ISO string) picks the data year; do not pass a date unless the user names a specific year."
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
  const { unitValue, unit, eGrid, date } = parsed.data;

  const parsedDate = date ? new Date(date) : new Date();
  if (Number.isNaN(parsedDate.getTime())) {
    return buildErrorEnvelope({
      code: "invalid_date",
      http_status: 400,
      message: `date could not be parsed as an ISO date: ${date}`,
      upgradeHint: null
    });
  }

  const eGridClass = classifyEGrid(eGrid);
  const resolvedEGrid = eGrid ?? "MROE";
  const carbonPerMwh = findCarbonTonsPerMwh(resolvedEGrid, parsedDate);
  const isUnknownRegion = eGridClass === "unknown";

  const warnings = [
    ...(eGridClass === "default_mroe"
      ? [
          {
            code: "conservative_default",
            message:
              "No eGrid region supplied — used MROE (upper-bound US subregion). Provide a state, eGrid code, or country for a locale-specific estimate."
          }
        ]
      : []),
    ...(isUnknownRegion
      ? [
          {
            code: "unknown_region",
            message: `Unrecognized eGrid region "${eGrid}" — fell back to the IEA global average (0.475 tCO2e/MWh).`
          }
        ]
      : [])
  ];

  const tCO2e = calcElectricEmissionsPerUnitValue({
    unit,
    unitValue,
    eGrid,
    date: parsedDate
  });

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Electricity calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const confidence = deriveConfidence({
    defaultsUsed: eGridClass === "default_mroe",
    unknownRegion: isUnknownRegion
  });

  const dataYear =
    eGridClass === "us_egrid" || eGridClass === "default_mroe"
      ? resolveEGridDataYear(parsedDate)
      : null;

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      unit_value: unitValue,
      unit,
      eGrid: resolvedEGrid,
      carbon_intensity_tco2e_per_mwh: carbonPerMwh,
      data_year: dataYear
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
