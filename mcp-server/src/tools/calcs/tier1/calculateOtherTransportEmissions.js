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

const { otherTransportationCarbon } = calcs;

const TRANSPORT_TYPES = [
  "bus",
  "lightRail",
  "regionalRail",
  "intercityRail",
  "carpool",
  "walkBike"
];

const SOURCES = [
  {
    name: "Aclymate transportation carbon factors (bus/rail/carpool)",
    vintage: "2024"
  }
];

const inputShape = {
  transportationType: z
    .enum(TRANSPORT_TYPES)
    .describe(
      "Transportation type. One of: bus, lightRail, regionalRail, intercityRail, carpool, walkBike. Required — unknown values are rejected (no silent zero)."
    ),
  mileage: z
    .number()
    .finite()
    .nonnegative()
    .describe("Trip distance in miles. Required.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_other_transport_emissions",
  title: "Calculate Other Transport Emissions",
  description:
    "Calculate tCO2e for non-flight, non-personal-vehicle transportation (bus, light rail, regional rail, intercity rail, carpool, walk/bike). `transportationType` and `mileage` are both required. Unknown transportation types are rejected — the tool will not silently return zero."
};

const buildValidationError = (parsed) => {
  const issues = parsed.error.issues;
  const transportTypeIssue = issues.find(
    (issue) => issue.path[0] === "transportationType"
  );
  if (transportTypeIssue) {
    return buildErrorEnvelope({
      code: "invalid_transport_type",
      http_status: 400,
      message: `Invalid transportationType. Valid values: ${TRANSPORT_TYPES.join(", ")}.`,
      upgradeHint: null
    });
  }
  return buildErrorEnvelope({
    code: "invalid_input",
    http_status: 400,
    message: issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    upgradeHint: null
  });
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { transportationType, mileage } = parsed.data;

  const isWalkBike = transportationType === "walkBike";

  const tCO2e = otherTransportationCarbon(transportationType, mileage);

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Other-transport calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const confidence = deriveConfidence({ isDefinitionalZero: isWalkBike });

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      mileage_mi: mileage,
      transportation_type: transportationType
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
