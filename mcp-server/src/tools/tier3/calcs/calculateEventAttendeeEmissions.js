import { z } from "zod";
import calcs from "@aclymatepackages/calcs/events/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import { FACTOR_SNAPSHOT, deriveConfidence, isValidCalcResult } from "./factorSnapshot.js";

const { calcEventAttendeeTravelData } = calcs;

const coordinatesShape = z.object({
  latitude: z.number(),
  longitude: z.number()
});

const inputShape = {
  attendeeCoordinates: coordinatesShape.describe("Attendee's home coordinates."),
  attendeeCountry: z.string().describe("Attendee's home country."),
  attendeeState: z
    .string()
    .optional()
    .describe("Attendee's home state/province — required for Northeast Corridor / SF rail-distance logic."),
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
  isTrainEvent: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether this event favors rail travel for eligible attendees."),
  nearestAirport: coordinatesShape.describe("Coordinates of the attendee's nearest airport."),
  fromAirportDistanceMi: z
    .number()
    .finite()
    .nonnegative()
    .describe("Driving distance in miles from the attendee's nearest airport to their point of origin."),
  layoverAirport: coordinatesShape
    .optional()
    .describe("Coordinates of an international layover airport, if the trip requires one."),
  transportationMethod: z
    .enum(["personalCar", "carpool", "train", "publicTransit", "flying"])
    .optional()
    .describe("Explicit transportation method. Omit to let the calc infer it from distance/location.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_event_attendee_emissions",
  title: "Calculate Event Attendee Emissions",
  description:
    "Calculate one attendee's round-trip travel emissions (tCO2e) to an event, given attendee and event coordinates. Infers car/rail/flight mode from distance and location unless transportationMethod is given."
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
    attendeeCoordinates,
    attendeeCountry,
    attendeeState,
    eventCoordinates,
    eventCountry,
    eventState,
    eventCity,
    eventDefaultAirport,
    isTrainEvent,
    nearestAirport,
    fromAirportDistanceMi,
    layoverAirport,
    transportationMethod
  } = parsed.data;

  if (isTrainEvent && (!eventState || !eventCity)) {
    return buildValidationError(
      "isTrainEvent requires eventState and eventCity to evaluate rail-eligible routes."
    );
  }

  let travelData;
  try {
    travelData = calcEventAttendeeTravelData({
      attendeeData: {
        coordinates: attendeeCoordinates,
        country: attendeeCountry,
        state: attendeeState
      },
      eventData: {
        defaultAirport: eventDefaultAirport,
        address: {
          country: eventCountry,
          coordinates: eventCoordinates,
          state: eventState,
          city: eventCity
        },
        isTrainEvent
      },
      nearestAirport,
      fromAirportDistanceMi,
      layoverAirport,
      transportationMethod
    });
  } catch (err) {
    return buildValidationError(
      `Unable to compute attendee travel data: ${err.message}`
    );
  }

  const { totalTravelTons } = travelData || {};
  if (!isValidCalcResult(totalTravelTons)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Event attendee calc returned unexpected value: ${totalTravelTons}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: { tCO2e: totalTravelTons, transportationMethod: transportationMethod ?? null },
    sources: [{ name: "Aclymate event-travel calc (via @aclymatepackages/calcs 8.x)" }],
    confidence: deriveConfidence({
      isDefinitionalZero: totalTravelTons === 0,
      defaultsUsed: !transportationMethod
    }),
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
