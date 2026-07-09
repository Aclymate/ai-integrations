import { z } from "zod";
import calcs from "@aclymatepackages/calcs/travel/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const { trainTransportationCarbon } = calcs;

const SOURCES = [
  {
    name: "US EPA passenger-rail emission factors (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const inputShape = {
  mileage: z
    .number()
    .finite()
    .positive()
    .describe("Trip distance in miles. Required."),
  trainType: z
    .enum(["lightRail", "regionalRail", "intercityRail"])
    .optional()
    .describe(
      "Rail service type. Omit for the intercity default. Note: setting `isNortheastCorridor: true` overrides this field."
    ),
  isNortheastCorridor: z
    .boolean()
    .optional()
    .describe(
      "True for Amtrak Northeast Corridor service — takes precedence over `trainType` per the underlying calc."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_train_emissions",
  title: "Calculate Train Emissions",
  description:
    "Calculate tCO2e for a passenger train trip using Aclymate's US EPA-based factors. Requires `mileage` in miles. Optional `trainType` (`lightRail`, `regionalRail`, `intercityRail`) — omit for the intercity-other default. `isNortheastCorridor: true` overrides `trainType` and applies the lower-carbon NEC factor."
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
  const { mileage, trainType, isNortheastCorridor } = parsed.data;

  const necOverridesType =
    Boolean(isNortheastCorridor) && Boolean(trainType) && trainType !== "intercityRail";
  const trainTypeDefaulted = !trainType && !isNortheastCorridor;

  const warnings = [
    ...(necOverridesType
      ? [
          {
            code: "nec_overrides_train_type",
            message: `isNortheastCorridor=true overrode trainType="${trainType}" — used the Northeast Corridor factor.`
          }
        ]
      : []),
    ...(trainTypeDefaulted
      ? [
          {
            code: "train_type_defaulted",
            message:
              "No trainType supplied and isNortheastCorridor=false — used the intercity-rail (other routes) factor."
          }
        ]
      : [])
  ];

  const tCO2e = trainTransportationCarbon(trainType, mileage, isNortheastCorridor);

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Train calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const usedBranch = isNortheastCorridor
    ? "northeastCorridor"
    : trainType || "intercityRail";

  const confidence = deriveConfidence({
    defaultsUsed: trainTypeDefaulted
  });

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      mileage_mi: mileage,
      train_type: trainType ?? null,
      is_northeast_corridor: Boolean(isNortheastCorridor),
      method: usedBranch
    },
    sources: SOURCES,
    confidence,
    warnings,
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
