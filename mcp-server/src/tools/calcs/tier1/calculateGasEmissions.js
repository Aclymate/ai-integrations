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

const { calcGasEmissionsPerUnitValue } = calcs;

const SOURCES = [
  {
    name: "EPA GHG Emission Factors Hub — stationary combustion (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const naturalGasSchema = z.object({
  fuelType: z.literal("naturalGas"),
  unit: z.enum(["therms", "mcf", "ccf", "scf", "cubicMeters"]).default("therms"),
  unitValue: z.number().finite().positive()
});

const propaneSchema = z.object({
  fuelType: z.literal("propane"),
  unit: z.enum(["scf", "gallons"]).default("gallons"),
  unitValue: z.number().finite().positive()
});

const heatingOilSchema = z.object({
  fuelType: z.literal("heatingOil"),
  unit: z.literal("gallons").default("gallons"),
  unitValue: z.number().finite().positive()
});

const woodSchema = z.object({
  fuelType: z.literal("wood"),
  unit: z.literal("cords").default("cords"),
  unitValue: z.number().finite().positive()
});

const zodSchema = z.discriminatedUnion("fuelType", [
  naturalGasSchema,
  propaneSchema,
  heatingOilSchema,
  woodSchema
]);

const inputShape = {
  fuelType: z
    .enum(["naturalGas", "propane", "heatingOil", "wood"])
    .describe("Fuel type. Each fuel accepts a specific unit set."),
  unit: z
    .string()
    .describe(
      "Unit for the fuel. naturalGas: therms|mcf|ccf|scf|cubicMeters (default therms). propane: scf|gallons (default gallons). heatingOil: gallons. wood: cords."
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
    "Calculate tCO2e for combustion of natural gas, propane, heating oil, or wood using EPA stationary-combustion factors. `fuelType` and `unitValue` are required; the accepted `unit` depends on the fuel: naturalGas → therms|mcf|ccf|scf|cubicMeters; propane → scf|gallons; heatingOil → gallons; wood → cords. Invalid (fuelType, unit) pairs are rejected at parse time — no silent passthrough."
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
