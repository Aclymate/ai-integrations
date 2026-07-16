import { z } from "zod";
import calcs from "@aclymatepackages/calcs/other/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const { calcPurchasedWaterTonsCo2e, calcWastewaterTonsCo2e } = calcs;

const SOURCES = [
  {
    name: "EPA purchased-water and wastewater-treatment emissions factors (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  quantity: z.number().finite().positive().describe("Quantity of purchased water."),
  unit: z
    .enum(["gallons", "cubicMeters"])
    .describe("Unit the quantity is measured in."),
  wastewaterPercentage: z
    .number()
    .finite()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Percentage of the purchased water sent to wastewater treatment (0-100). Omit if unknown — wastewater emissions are additive and only included when this is supplied."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_water_emissions",
  title: "Calculate Water Emissions",
  description:
    "Calculate tCO2e for purchased water, optionally including wastewater-treatment emissions when `wastewaterPercentage` is supplied."
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
  const { quantity, unit, wastewaterPercentage } = parsed.data;

  const purchasedWaterTCO2e = calcPurchasedWaterTonsCo2e(quantity, unit);
  const wastewaterTCO2e =
    wastewaterPercentage != null
      ? calcWastewaterTonsCo2e(quantity, unit, wastewaterPercentage)
      : 0;
  const tCO2e = purchasedWaterTCO2e + wastewaterTCO2e;

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Water calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      purchased_water_tCO2e: purchasedWaterTCO2e,
      wastewater_tCO2e: wastewaterPercentage != null ? wastewaterTCO2e : null,
      quantity,
      unit
    },
    sources: SOURCES,
    confidence: deriveConfidence({}),
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
