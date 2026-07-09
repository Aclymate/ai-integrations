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

const { flightEmissions } = calcs;

const NYC_LA_ROUND_TRIP_KM = 7876;

const SOURCES = [
  {
    name: "DEFRA Air Passenger Table (via @aclymatepackages/calcs 8.x)",
    vintage: "2024"
  }
];

const coordinateSchema = z.object({
  lat: z.number().finite(),
  lng: z.number().finite()
});

const inputShape = {
  distance: z.number().finite().positive().optional().describe(
    "Round-trip distance in kilometers. Preferred input — pass this if you can compute it yourself (e.g. from airport codes or city names)."
  ),
  passClass: z
    .enum(["economy", "premium", "business", "first"])
    .optional()
    .describe("Cabin class. Omit for the DEFRA average across classes."),
  to: coordinateSchema
    .optional()
    .describe("Destination coordinates {lat, lng}. Alternative to distance."),
  from: coordinateSchema
    .optional()
    .describe("Origin coordinates {lat, lng}. Alternative to distance.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_flight_emissions",
  title: "Calculate Flight Emissions",
  description:
    "Calculate tCO2e for a flight using Aclymate's DEFRA-based factors. Pass `distance` in kilometers if you can compute it yourself (from airport codes, city names, etc.). Pass `{to, from}` as coordinate objects if you have them structured. Omit both for a US-domestic NYC↔LA ballpark. Always prefer `distance` when available — it is the most forgiving input path."
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
  const { distance, passClass, to, from } = parsed.data;

  const hasCoordinates = Boolean(to && from);
  const usedDistance = distance ?? (hasCoordinates ? null : NYC_LA_ROUND_TRIP_KM);
  const usedDefaultDistance = !distance && !hasCoordinates;
  const missingPassClass = !passClass;

  const method = distance
    ? "distance"
    : hasCoordinates
    ? "coordinates"
    : "default";

  const warnings = [
    ...(usedDefaultDistance
      ? [
          {
            code: "default_used",
            message:
              "No distance or coordinates supplied — used NYC↔LA round-trip default (7,876 km)."
          }
        ]
      : []),
    ...(missingPassClass
      ? [
          {
            code: "class_defaulted",
            message:
              "passClass omitted — used the DEFRA average across cabin classes."
          }
        ]
      : [])
  ];

  const tCO2e = flightEmissions({ to, from, passClass, distance });

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Flight calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  const confidence = deriveConfidence({
    defaultsUsed: usedDefaultDistance || missingPassClass
  });

  // TODO(upstream calcs 9.x): if flightEmissions is refactored to return
  // {tCO2e, distance_km}, drop this second flightGcdFromCoordinates call —
  // it duplicates work the helper already did internally.
  const distanceKmOut =
    usedDistance ??
    (hasCoordinates ? calcs.flightGcdFromCoordinates(to, from) : null);

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      distance_km: distanceKmOut,
      pass_class: passClass ?? null,
      method
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
