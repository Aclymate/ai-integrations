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

const { calcGasEmissionsPerUnitValue, GAS_FUEL_UNIT_MAP, GAS_FUEL_TYPES } = calcs;

const SOURCES = [
  {
    name: "EPA GHG Emission Factors Hub — stationary combustion (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const DEFAULT_UNIT_FOR_FUEL = {
  naturalGas: "therms",
  propane: "gallons",
  heatingOil: "gallons",
  wood: "cords",
  kerosene: "gallons"
};

const buildFuelBranch = (fuelType) => {
  const units = GAS_FUEL_UNIT_MAP[fuelType];
  const unitSchema =
    units.length === 1
      ? z.literal(units[0]).default(units[0])
      : z.enum([...units]).default(DEFAULT_UNIT_FOR_FUEL[fuelType]);
  return z.object({
    fuelType: z.literal(fuelType),
    unit: unitSchema,
    unitValue: z.number().finite().positive()
  });
};

const zodSchema = z.discriminatedUnion(
  "fuelType",
  GAS_FUEL_TYPES.map(buildFuelBranch)
);

const inputShape = {
  fuelType: z
    .enum([...GAS_FUEL_TYPES])
    .describe("Fuel type. Each fuel accepts a specific unit set."),
  unit: z
    .string()
    .describe(
      "Unit for the fuel. naturalGas: therms|mcf|ccf|scf|cubicMeters (default therms). propane: scf|gallons (default gallons). heatingOil: gallons. wood: cords. kerosene: gallons."
    ),
  unitValue: z
    .number()
    .finite()
    .positive()
    .describe("Positive quantity in the specified unit.")
};

const definition = {
  name: "calculate_gas_emissions",
  title: "Calculate Gas Emissions",
  description:
    "Calculate tCO2e for combustion of natural gas, propane, heating oil, wood, or kerosene using EPA stationary-combustion factors. `fuelType` and `unitValue` are required; the accepted `unit` depends on the fuel: naturalGas → therms|mcf|ccf|scf|cubicMeters; propane → scf|gallons; heatingOil → gallons; wood → cords; kerosene → gallons. Invalid (fuelType, unit) pairs are rejected at parse time — no silent passthrough."
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
  const { fuelType, unit, unitValue } = parsed.data;

  const tCO2e = calcGasEmissionsPerUnitValue({ unit, unitValue, fuelType });

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Gas calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const confidence = deriveConfidence({});

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      unit_value: unitValue,
      unit,
      fuel_type: fuelType
    },
    sources: SOURCES,
    confidence,
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
