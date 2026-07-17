import { z } from "zod";
import calcs from "@aclymatepackages/calcs/events/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, deriveConfidence, isValidCalcResult } from "./factorSnapshot.js";

const { formatEventEmissionsTons } = calcs;

const coordinatesShape = z.object({
  latitude: z.number(),
  longitude: z.number()
});

const attendeeStateBreakdownShape = z.object({
  state: z.string().describe("US state name, lowercase (e.g. 'california')."),
  percentage: z.number().finite().min(0).max(100)
});

const subcategoryBreakdownShape = z.object({
  subcategory: z.string(),
  tonsCo2e: z.number().finite()
});

const aggregatedTransactionMonthShape = z.object({
  date: z.string().describe("ISO month string for this aggregation bucket."),
  subcategoriesBreakdown: z.array(subcategoryBreakdownShape).default([])
});

const inputShape = {
  eventId: z.string().optional().default("event"),
  eventCoordinates: coordinatesShape.describe("Event venue coordinates."),
  eventCountry: z.string().describe("Event venue country."),
  eventState: z
    .string()
    .optional()
    .describe("Event venue state/province — required for Northeast Corridor / SF rail-distance logic."),
  eventCity: z
    .string()
    .optional()
    .describe("Event venue city — required for the San Francisco short-hop rail case."),
  eventDefaultAirport: coordinatesShape.describe("Coordinates of the event's default/nearest airport."),
  venueElectricTons: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .default(0)
    .describe("Venue on-site electricity tCO2e for the event, if known."),
  venueGasTons: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .default(0)
    .describe("Venue on-site gas tCO2e for the event, if known."),
  attendeeCount: z.number().finite().positive().describe("Total number of attendees."),
  attendeesStateBreakdown: z
    .array(attendeeStateBreakdownShape)
    .optional()
    .default([])
    .describe("Percent of attendees per US state of origin. Unlisted percentage is spread across a nationwide population-weighted average."),
  aggregatedTransactions: z
    .array(aggregatedTransactionMonthShape)
    .optional()
    .default([])
    .describe("On-site spend-category emissions for the event, if any were tracked (e.g. catering, supplies)."),
  isTrainEvent: z.boolean().optional().default(false)
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_event_total_emissions",
  title: "Calculate Event Total Emissions",
  description:
    "Calculate a whole event's total tCO2e — attendee travel (from a state-of-origin breakdown), venue utilities, and any on-site spend-category transactions."
};

const buildValidationError = (message) =>
  buildErrorEnvelope({
    code: "invalid_input",
    http_status: 400,
    message,
    upgradeHint: null
  });

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")
    );
  }

  const {
    eventId,
    eventCoordinates,
    eventCountry,
    eventState,
    eventCity,
    eventDefaultAirport,
    venueElectricTons,
    venueGasTons,
    attendeeCount,
    attendeesStateBreakdown,
    aggregatedTransactions,
    isTrainEvent
  } = parsed.data;

  if (isTrainEvent && (!eventState || !eventCity)) {
    return buildValidationError(
      "isTrainEvent requires eventState and eventCity to evaluate rail-eligible routes."
    );
  }

  const stateBreakdownTotalPercentage = attendeesStateBreakdown.reduce(
    (sum, { percentage }) => sum + percentage,
    0
  );
  if (stateBreakdownTotalPercentage > 100) {
    return buildValidationError(
      `attendeesStateBreakdown percentages sum to ${stateBreakdownTotalPercentage}, which exceeds 100.`
    );
  }

  const event = {
    id: eventId,
    address: { country: eventCountry, coordinates: eventCoordinates, state: eventState, city: eventCity },
    defaultAirport: eventDefaultAirport,
    venueElectricTons,
    venueGasTons,
    attendeeCount,
    attendeesStateBreakdown,
    isTrainEvent
  };

  const eventAggregatedTransactions = aggregatedTransactions.length
    ? [{ eventId, aggregatedTransactions }]
    : [];

  let formatted;
  try {
    formatted = formatEventEmissionsTons([event], eventAggregatedTransactions);
  } catch (err) {
    return buildValidationError(`Unable to compute event totals: ${err.message}`);
  }

  const [result] = formatted || [];
  const tCO2e = result?.tonsCo2e;

  if (!isValidCalcResult(tCO2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Event total calc returned unexpected value: ${tCO2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      tCO2e,
      attendeeEmissionsTons: result.attendeeEmissionsTons,
      totalTransactionsTons: result.totalTransactionsTons,
      transactionSubcategoriesTons: result.transactionSubcategoriesTons
    },
    sources: [{ name: "Aclymate event-travel calc (via @aclymatepackages/calcs 8.x)" }],
    confidence: deriveConfidence({
      isDefinitionalZero: tCO2e === 0,
      defaultsUsed: attendeesStateBreakdown.length === 0
    }),
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
