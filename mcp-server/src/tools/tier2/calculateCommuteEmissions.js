import { z } from "zod";
import calcs from "@aclymatepackages/calcs/travel/index.js";
import commuteCalcs from "@aclymatepackages/calcs/recurring/commuting.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, isValidCalcResult } from "./factorSnapshot.js";
import { resolveVehicleFactor } from "./vehicleFactorLookup.js";

const { defaultVehicleTonsCo2ePerMile } = calcs;
const { commuteTonsFromDistance } = commuteCalcs;

const GRAMS_PER_TON = 1_000_000;
const GRAMS_PER_MILE_TO_TONS_PER_MILE = (gramsPerMile) => gramsPerMile / GRAMS_PER_TON;

const inputShape = {
  oneWayDistanceMi: z
    .number()
    .finite()
    .positive()
    .describe("One-way commute distance, in miles."),
  daysPerWeek: z
    .number()
    .finite()
    .min(0)
    .max(7)
    .describe("Days per week the commute is made."),
  make: z
    .string()
    .optional()
    .describe("Commute vehicle make, e.g. 'Mazda'. Improves accuracy when paired with model."),
  model: z
    .string()
    .optional()
    .describe("Commute vehicle model, e.g. 'CX-5'. Improves accuracy when paired with make."),
  year: z
    .number()
    .int()
    .optional()
    .describe("Commute vehicle model year. Used with make/model for the most precise factor.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_commute_emissions",
  title: "Calculate Commute Emissions",
  description:
    "Calculate monthly tCO2e for a recurring commute, given one-way distance and days per week. Pass `make`/`model`/`year` if known for a precise per-vehicle factor — omit for a blended average-vehicle default. Shares the same per-mile kernel as Aclymate's Navigator commute-schedule feature."
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

const resolveTonsCo2ePerMile = ({ make, model, year }) => {
  const lookup = resolveVehicleFactor({ make, model, year });
  if (lookup.match === "none") {
    return { tonsCo2ePerMile: defaultVehicleTonsCo2ePerMile, lookup };
  }
  return {
    tonsCo2ePerMile: GRAMS_PER_MILE_TO_TONS_PER_MILE(lookup.row.values.co2_g_per_mile),
    lookup
  };
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { oneWayDistanceMi, daysPerWeek, make, model, year } = parsed.data;

  const { tonsCo2ePerMile, lookup } = resolveTonsCo2ePerMile({ make, model, year });

  const tCO2e = commuteTonsFromDistance({
    tonsCo2ePerMile,
    oneWayDistanceMi,
    daysPerWeek,
    monthFraction: 1
  });

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Commute calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const isExactVehicleMatch = lookup.match === "exact";
  const usedVehicleFactor = lookup.match !== "none";

  const warnings = usedVehicleFactor
    ? isExactVehicleMatch
      ? []
      : [
          {
            code: "vehicle_year_fallback",
            message: `Requested year not found — used ${lookup.row.keys.vehicle_year} data, the nearest available year for this model.`
          }
        ]
    : [
        {
          code: "default_vehicle_used",
          message:
            "No make/model match found — used the blended average-vehicle default."
        }
      ];

  return buildSuccessEnvelope({
    result: { tCO2e, oneWayDistanceMi, daysPerWeek, monthFraction: 1 },
    sources: [
      usedVehicleFactor
        ? {
            name: lookup.row.source.name,
            url: lookup.row.source.url,
            vintage: String(lookup.row.source.vintage_year),
            factor_id: lookup.row.factor_id
          }
        : {
            name: "Aclymate blended car/light-truck default (via @aclymatepackages/calcs 8.x)",
            vintage: "2024"
          }
    ],
    confidence: isExactVehicleMatch ? "high" : "medium",
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
