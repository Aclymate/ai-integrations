import { z } from "zod";
import calcs from "@aclymatepackages/calcs/travel/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, isValidCalcResult } from "./factorSnapshot.js";
import { resolveVehicleFactor } from "./vehicleFactorLookup.js";

const { defaultVehicleTonsCo2ePerMile } = calcs;

const GRAMS_PER_TON = 1_000_000;

const inputShape = {
  distanceMi: z.number().finite().positive().describe("Distance driven, in miles."),
  make: z
    .string()
    .optional()
    .describe("Vehicle make, e.g. 'Mazda'. Improves accuracy when paired with model."),
  model: z
    .string()
    .optional()
    .describe("Vehicle model, e.g. 'CX-5'. Improves accuracy when paired with make."),
  year: z
    .number()
    .int()
    .optional()
    .describe("Model year, e.g. 2023. Used with make/model for the most precise factor."),
  fuelType: z
    .enum(["gasoline", "diesel", "hybrid", "electric"])
    .optional()
    .describe("Fuel type, if known — disambiguates when a make/model/year has more than one.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_vehicle_emissions",
  title: "Calculate Vehicle Emissions",
  description:
    "Calculate tCO2e for vehicle travel. Pass `make`/`model`/`year` if known for a precise EPA-sourced factor (e.g. 'Mazda', 'CX-5', 2023) — omit for a blended average-vehicle default."
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
  const { distanceMi, make, model, year, fuelType } = parsed.data;

  const lookup = resolveVehicleFactor({ make, model, year, fuelType });

  if (lookup.match === "none") {
    const tCO2e = defaultVehicleTonsCo2ePerMile * distanceMi;
    if (!isValidCalcResult(tCO2e)) {
      return buildErrorEnvelope({
        code: "calc_unexpected_output",
        http_status: 500,
        message: `Vehicle calc returned unexpected value: ${tCO2e}`,
        upgradeHint: null
      });
    }
    return buildSuccessEnvelope({
      result: { tCO2e, distanceMi, make: make ?? null, model: model ?? null, year: year ?? null },
      sources: [
        {
          name: "Aclymate blended car/light-truck default (via @aclymatepackages/calcs 8.x)",
          vintage: "2024"
        }
      ],
      confidence: "medium",
      warnings: [
        {
          code: "default_vehicle_used",
          message:
            "No make/model match found — used the blended average-vehicle default."
        }
      ],
      factorSnapshot: FACTOR_SNAPSHOT,
      methodologyUrl: null,
      viewInAclymateUrl: null,
      upgradeHint: null
    });
  }

  const { row } = lookup;
  const tCO2e = (row.values.co2_g_per_mile * distanceMi) / GRAMS_PER_TON;

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Vehicle calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const isExact = lookup.match === "exact";

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      distanceMi,
      make: row.keys.make,
      model: row.keys.model,
      year: row.keys.vehicle_year,
      fuelType: row.keys.fuel_type
    },
    sources: [
      {
        name: row.source.name,
        url: row.source.url,
        vintage: String(row.source.vintage_year),
        factor_id: row.factor_id
      }
    ],
    confidence: isExact ? "high" : "medium",
    warnings: isExact
      ? []
      : [
          {
            code: "vehicle_year_fallback",
            message: `Requested year not found — used ${row.keys.vehicle_year} data, the nearest available year for this model.`
          }
        ],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
