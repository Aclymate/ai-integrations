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

const { calcSteamTonsCo2e } = calcs;

const SOURCES = [
  {
    name: "EPA purchased-steam emissions factor (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  quantity: z.number().finite().positive().describe("Quantity of purchased steam."),
  unit: z.enum(["lbs", "kgs"]).describe("Unit the quantity is measured in.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_steam_emissions",
  title: "Calculate Steam Emissions",
  description:
    "Calculate tCO2e for purchased steam using Aclymate's emissions factor."
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
  const { quantity, unit } = parsed.data;

  const tCO2e = calcSteamTonsCo2e(quantity, unit);

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Steam calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: { tCO2e, quantity, unit },
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
