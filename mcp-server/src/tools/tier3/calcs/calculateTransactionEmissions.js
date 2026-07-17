import { z } from "zod";
import { createRequire } from "node:module";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, isValidCalcResult } from "./factorSnapshot.js";

const require_ = createRequire(import.meta.url);
const { subcategories } = require_("@aclymatepackages/lists");

const STEERED_SUBCATEGORIES = Object.freeze({
  fuel: "calculate_gas_emissions",
  gas: "calculate_gas_emissions",
  electricity: "calculate_electricity_emissions",
  utilities: "calculate_electricity_emissions"
});

const inputShape = {
  dollarAmount: z
    .number()
    .finite()
    .describe(
      "Transaction amount, in US dollars. Negative amounts (refunds/credits) are accepted — the result is always a positive tCO2e, matching Navigator's own transaction calc."
    ),
  subcategory: z
    .string()
    .describe(
      "The transaction's Aclymate subcategory (e.g. 'flights', 'hotels', 'rides', 'spend-based'). Fuel/gas/electricity/utilities subcategories are not covered here — use the dedicated activity tools for those."
    ),
  tonsCo2ePerDollar: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .describe(
      "Required when subcategory is 'spend-based': the vendor's confirmed tCO2e-per-dollar factor."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_transaction_emissions",
  title: "Calculate Transaction Emissions",
  description:
    "Calculate tCO2e for a spend-based or NAICS-mapped financial transaction (flights, hotels, rides, trains, and similar spend categories). For fuel, gas, electricity, or utilities transactions, use the dedicated activity tool instead — this tool returns a steer, not a number, for those subcategories."
};

const buildValidationError = (message) =>
  buildErrorEnvelope({
    code: "invalid_input",
    http_status: 400,
    message,
    upgradeHint: null
  });

const buildUnexpectedOutputError = (tCO2e) =>
  buildErrorEnvelope({
    code: "calc_unexpected_output",
    http_status: 500,
    message: `Transaction calc returned unexpected value: ${tCO2e}`,
    upgradeHint: null
  });

const buildSteerError = (subcategory, dedicatedTool) =>
  buildErrorEnvelope({
    code: "unsupported_subcategory",
    http_status: 400,
    message: `'${subcategory}' transactions aren't covered by calculate_transaction_emissions — use ${dedicatedTool} instead.`,
    upgradeHint: null
  });

const calculateSpendBased = ({ dollarAmount, tonsCo2ePerDollar }) => {
  if (tonsCo2ePerDollar === undefined) {
    return buildValidationError(
      "subcategory 'spend-based' requires tonsCo2ePerDollar."
    );
  }
  const tCO2e = Math.abs(tonsCo2ePerDollar * dollarAmount);
  if (!isValidCalcResult(tCO2e)) {
    return buildUnexpectedOutputError(tCO2e);
  }
  return buildSuccessEnvelope({
    result: { tCO2e, dollarAmount, subcategory: "spend-based", tonsCo2ePerDollar },
    sources: [{ name: "Caller-supplied tonsCo2ePerDollar factor" }],
    confidence: "high",
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

const calculateNaics = ({ dollarAmount, subcategory }) => {
  const { naics } =
    subcategories.find(
      (subcategoryObj) => subcategoryObj.subcategory === subcategory
    ) || {};

  if (!naics?.tonsCo2ePerDollar) {
    return buildValidationError(
      `'${subcategory}' has no known NAICS spend factor. Provide tonsCo2ePerDollar and use subcategory 'spend-based', or use a supported subcategory.`
    );
  }

  const tCO2e = Math.abs(naics.tonsCo2ePerDollar * dollarAmount);
  if (!isValidCalcResult(tCO2e)) {
    return buildUnexpectedOutputError(tCO2e);
  }
  return buildSuccessEnvelope({
    result: { tCO2e, dollarAmount, subcategory, tonsCo2ePerDollar: naics.tonsCo2ePerDollar },
    sources: [
      { name: "@aclymatepackages/lists NAICS spend-based factor", factor_id: naics.code }
    ],
    confidence: "medium",
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")
    );
  }
  const { dollarAmount, subcategory, tonsCo2ePerDollar } = parsed.data;

  const dedicatedTool = STEERED_SUBCATEGORIES[subcategory];
  if (dedicatedTool) {
    return buildSteerError(subcategory, dedicatedTool);
  }

  if (subcategory === "spend-based") {
    return calculateSpendBased({ dollarAmount, tonsCo2ePerDollar });
  }

  return calculateNaics({ dollarAmount, subcategory });
};

export { definition, inputShape, handler };
