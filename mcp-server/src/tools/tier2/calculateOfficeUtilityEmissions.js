import { z } from "zod";
import utilityCalcs from "@aclymatepackages/calcs/utilities/index.js";
import otherCalcs from "@aclymatepackages/calcs/other/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const { calcGasEmissionsPerUnitValue, calcElectricEmissionsPerUnitValue, classifyEGrid } =
  utilityCalcs;
const { calcPurchasedWaterTonsCo2e } = otherCalcs;

const SOURCES = [
  {
    name: "EPA gas/electric/water emissions factors (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const utilityLineItemSchema = z.union([
  z.object({
    type: z.literal("gas"),
    quantity: z.number().finite().positive(),
    unit: z.enum(["therms", "ccf", "mcf", "cubicMeters", "gallons"]),
    fuelType: z.enum(["naturalGas", "propane", "heatingOil", "wood"]).optional()
  }),
  z.object({
    type: z.literal("electric"),
    quantity: z.number().finite().positive(),
    unit: z.enum(["kwh", "mwh"]),
    eGrid: z
      .string()
      .optional()
      .describe(
        "US eGRID subregion code, Canadian province, or country. If omitted, defaults to MROE — the upper-bound US subregion (a conservative estimator, not a locale-specific default)."
      )
  }),
  z.object({
    type: z.literal("water"),
    quantity: z.number().finite().positive(),
    unit: z.enum(["gallons", "cubicMeters"])
  })
]);

const inputShape = {
  utilities: z
    .array(utilityLineItemSchema)
    .min(1)
    .describe(
      "One line-item per utility type present (gas, electric, water). Omit types you don't have data for — absent types are excluded from the breakdown, never defaulted to zero."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_office_utility_emissions",
  title: "Calculate Office Utility Emissions",
  description:
    "Calculate tCO2e for office utilities (gas, electric, water) from whichever line-items you have — pass one call with all the utility types you have data for. An `electric` line-item's optional `eGrid` accepts a US eGRID subregion code, Canadian province, or country; if omitted, defaults to MROE (the upper-bound US subregion) and surfaces a conservative_default warning."
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

const calcLineItemTons = (lineItem) => {
  if (lineItem.type === "gas") {
    return calcGasEmissionsPerUnitValue({
      unit: lineItem.unit,
      unitValue: lineItem.quantity,
      fuelType: lineItem.fuelType ?? "naturalGas"
    });
  }
  if (lineItem.type === "electric") {
    return calcElectricEmissionsPerUnitValue({
      unit: lineItem.unit,
      unitValue: lineItem.quantity,
      eGrid: lineItem.eGrid
    });
  }
  return calcPurchasedWaterTonsCo2e(lineItem.quantity, lineItem.unit);
};

// Mirrors calculate_electricity_emissions's own region handling — an "electric" line item
// with no eGrid silently used MROE (upper-bound US subregion) at confidence: high with no
// warning and no way to override, while the standalone electricity calculator flags the
// same default as conservative and lets the caller set a region. Carries that same
// classification across so multi-utility calls get the identical warning/confidence.
const classifyElectricLineItem = (lineItem) => {
  if (lineItem.type !== "electric") return null;
  const eGridClass = classifyEGrid(lineItem.eGrid);
  return {
    eGrid: lineItem.eGrid ?? "MROE",
    eGridClass,
    isUnknownRegion: eGridClass === "unknown"
  };
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { utilities } = parsed.data;

  const breakdown = utilities.map((lineItem) => ({
    type: lineItem.type,
    tCO2e: calcLineItemTons(lineItem)
  }));

  const invalidEntry = breakdown.find(({ tCO2e }) => !isValidCalcResult(tCO2e));
  if (invalidEntry) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Office utility calc returned unexpected value for ${invalidEntry.type}: ${invalidEntry.tCO2e}`,
      upgradeHint: null
    });
  }

  const tCO2e = breakdown.reduce((sum, { tCO2e: itemTons }) => sum + itemTons, 0);

  const electricClassifications = utilities.map(classifyElectricLineItem).filter(Boolean);
  const usedDefaultMroe = electricClassifications.some((c) => c.eGridClass === "default_mroe");
  const unknownRegions = electricClassifications
    .filter((c) => c.isUnknownRegion)
    .map((c) => c.eGrid);

  const warnings = [
    ...(usedDefaultMroe
      ? [
          {
            code: "conservative_default",
            message:
              "No eGrid region supplied for one or more electric line items — used MROE (upper-bound US subregion). Provide a state, eGrid code, or country for a locale-specific estimate."
          }
        ]
      : []),
    ...(unknownRegions.length > 0
      ? [
          {
            code: "unknown_region",
            message: `Unrecognized eGrid region(s) ${unknownRegions.map((r) => `"${r}"`).join(", ")} — fell back to the IEA global average (0.475 tCO2e/MWh) for those line items.`
          }
        ]
      : [])
  ];

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      breakdown: breakdown.reduce(
        (acc, { type, tCO2e: itemTons }) => ({ ...acc, [type]: itemTons }),
        {}
      )
    },
    sources: SOURCES,
    confidence: deriveConfidence({
      defaultsUsed: usedDefaultMroe,
      unknownRegion: unknownRegions.length > 0
    }),
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
