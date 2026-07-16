import { z } from "zod";
import calcs from "@aclymatepackages/calcs/travel/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const { calcShippingEmissionsTons } = calcs;

const SOURCES = [
  {
    name: "EPA freight emissions factors, table 8 (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  distanceMi: z.number().finite().positive().describe("Shipping distance, in miles."),
  weightTons: z.number().finite().positive().describe("Shipment weight, in (metric) tons."),
  travelMethod: z
    .enum(["road", "rail", "sea", "air"])
    .describe("Shipping method.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_shipping_emissions",
  title: "Calculate Shipping Emissions",
  description:
    "Calculate tCO2e for a freight shipment using Aclymate's EPA-based factors for road, rail, sea, or air."
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
  const { distanceMi, weightTons, travelMethod } = parsed.data;

  const tCO2e = calcShippingEmissionsTons(distanceMi, weightTons, travelMethod);

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Shipping calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: { tCO2e, distanceMi, weightTons, travelMethod },
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
