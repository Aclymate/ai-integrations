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

const { calcRefrigerantsTonsCo2e } = calcs;

const SOURCES = [
  {
    name: "IPCC AR5 GWP factors (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  quantity: z.number().finite().positive().describe("Quantity of refrigerant."),
  unit: z
    .enum(["lbs", "kgs"])
    .describe("Unit the quantity is measured in."),
  refrigerantType: z
    .enum(["r410a", "r22", "hfo1234yf"])
    .describe("Refrigerant type.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_refrigerant_emissions",
  title: "Calculate Refrigerant Emissions",
  description:
    "Calculate tCO2e for a refrigerant leak or top-off using Aclymate's GWP-based factors. Supports r410a, r22, and hfo1234yf."
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
  const { quantity, unit, refrigerantType } = parsed.data;

  const tCO2e = calcRefrigerantsTonsCo2e(quantity, unit, refrigerantType);

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Refrigerant calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: { tCO2e, quantity, unit, refrigerantType },
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
