import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handler as calcTransactionEmissions
} from "../src/tools/tier3/calcs/calculateTransactionEmissions.js";
import {
  handler as calcEventAttendeeEmissions
} from "../src/tools/tier3/calcs/calculateEventAttendeeEmissions.js";
import {
  handler as calcEventTotalEmissions
} from "../src/tools/tier3/calcs/calculateEventTotalEmissions.js";
import calcs from "@aclymatepackages/calcs/events/index.js";

const { calcEventAttendeeTravelData } = calcs;

const assertSuccessEnvelope = (env) => {
  assert.equal(env.error, null, `expected error===null, got ${JSON.stringify(env.error)}`);
  assert.ok(env.result, "expected result to be populated");
  assert.equal(env.factor_snapshot.package, "@aclymatepackages/calcs");
  assert.ok(env.factor_snapshot.version, "factor_snapshot.version must be resolved");
  assert.ok(Array.isArray(env.sources) && env.sources.length > 0);
  assert.ok(Array.isArray(env.warnings));
};

const assertErrorEnvelope = (env, expectedCode) => {
  assert.ok(env.error, `expected error to be populated for code=${expectedCode}`);
  assert.equal(env.error.code, expectedCode);
  assert.equal(env.result, null);
};

test("calculate_transaction_emissions — spend-based matches tonsCo2ePerDollar × dollarAmount", async () => {
  const env = await calcTransactionEmissions({
    dollarAmount: 500,
    subcategory: "spend-based",
    tonsCo2ePerDollar: 0.0002
  });
  assertSuccessEnvelope(env);
  assert.ok(Math.abs(env.result.tCO2e - 500 * 0.0002) < 1e-12);
});

test("calculate_transaction_emissions — spend-based without tonsCo2ePerDollar is invalid_input, not a zero result", async () => {
  const env = await calcTransactionEmissions({ dollarAmount: 500, subcategory: "spend-based" });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_transaction_emissions — negative dollarAmount (refund/credit) matches Navigator's returnPositiveTons behavior", async () => {
  const env = await calcTransactionEmissions({
    dollarAmount: -500,
    subcategory: "spend-based",
    tonsCo2ePerDollar: 0.0002
  });
  assertSuccessEnvelope(env);
  assert.ok(Math.abs(env.result.tCO2e - Math.abs(-500 * 0.0002)) < 1e-12);
  assert.ok(env.result.tCO2e >= 0);
});

test("calculate_transaction_emissions — NAICS subcategory ('flights') matches @aclymatepackages/lists factor × amount", async () => {
  const env = await calcTransactionEmissions({ dollarAmount: 1000, subcategory: "flights" });
  assertSuccessEnvelope(env);
  assert.ok(Math.abs(env.result.tCO2e - 1000 * 0.000976) < 1e-9);
});

test("calculate_transaction_emissions — fuel subcategory steers to the dedicated tool instead of a number", async () => {
  const env = await calcTransactionEmissions({ dollarAmount: 100, subcategory: "fuel" });
  assertErrorEnvelope(env, "unsupported_subcategory");
  assert.match(env.error.message, /calculate_gas_emissions/);
});

test("calculate_transaction_emissions — electricity subcategory steers to the dedicated tool", async () => {
  const env = await calcTransactionEmissions({ dollarAmount: 100, subcategory: "electricity" });
  assertErrorEnvelope(env, "unsupported_subcategory");
  assert.match(env.error.message, /calculate_electricity_emissions/);
});

test("calculate_transaction_emissions — unknown/unpriced subcategory is invalid_input, not a zero result", async () => {
  const env = await calcTransactionEmissions({ dollarAmount: 100, subcategory: "not-a-real-subcategory" });
  assertErrorEnvelope(env, "invalid_input");
});

const SF_ATTENDEE = { latitude: 37.7749, longitude: -122.4194 };
const SF_EVENT = { latitude: 37.7849, longitude: -122.4094 };

test("calculate_event_attendee_emissions — matches the wrapped calc's direct output for a known input", async () => {
  const input = {
    attendeeCoordinates: SF_ATTENDEE,
    attendeeCountry: "US",
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    nearestAirport: { latitude: 37.6213, longitude: -122.379 },
    fromAirportDistanceMi: 15,
    transportationMethod: "personalCar"
  };
  const env = await calcEventAttendeeEmissions(input);
  assertSuccessEnvelope(env);

  const expected = calcEventAttendeeTravelData({
    attendeeData: { coordinates: SF_ATTENDEE, country: "US", state: undefined },
    eventData: {
      defaultAirport: input.eventDefaultAirport,
      address: { country: "US", coordinates: SF_EVENT, state: undefined, city: undefined },
      isTrainEvent: false
    },
    nearestAirport: input.nearestAirport,
    fromAirportDistanceMi: 15,
    layoverAirport: undefined,
    transportationMethod: "personalCar"
  });
  assert.ok(Math.abs(env.result.tCO2e - expected.totalTravelTons) < 1e-9);
});

test("calculate_event_attendee_emissions — missing required coordinates is invalid_input", async () => {
  const env = await calcEventAttendeeEmissions({ attendeeCountry: "US" });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_event_attendee_emissions — isTrainEvent without eventState/eventCity is invalid_input", async () => {
  const env = await calcEventAttendeeEmissions({
    attendeeCoordinates: SF_ATTENDEE,
    attendeeCountry: "US",
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    nearestAirport: { latitude: 37.6213, longitude: -122.379 },
    fromAirportDistanceMi: 15,
    isTrainEvent: true
  });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_event_total_emissions — happy path returns a populated tCO2e", async () => {
  const env = await calcEventTotalEmissions({
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    attendeeCount: 100,
    attendeesStateBreakdown: [{ state: "california", percentage: 100 }]
  });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
  assert.equal(env.result.totalTransactionsTons, 0);
});

test("calculate_event_total_emissions — all-virtual event (attendeeCount present, zero-percent breakdown) is not penalized as low confidence", async () => {
  const env = await calcEventTotalEmissions({
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    attendeeCount: 10,
    attendeesStateBreakdown: [{ state: "california", percentage: 100 }],
    venueElectricTons: 0,
    venueGasTons: 0
  });
  assertSuccessEnvelope(env);
});

test("calculate_event_total_emissions — attendeesStateBreakdown percentages summing above 100 is invalid_input, not a silently-wrong number", async () => {
  const env = await calcEventTotalEmissions({
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    attendeeCount: 100,
    attendeesStateBreakdown: [
      { state: "california", percentage: 60 },
      { state: "new york", percentage: 60 }
    ]
  });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_event_total_emissions — missing attendeeCount is invalid_input", async () => {
  const env = await calcEventTotalEmissions({
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 }
  });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_event_total_emissions — with on-site aggregatedTransactions adds to totalTransactionsTons", async () => {
  const env = await calcEventTotalEmissions({
    eventCoordinates: SF_EVENT,
    eventCountry: "US",
    eventDefaultAirport: { latitude: 37.6213, longitude: -122.379 },
    attendeeCount: 100,
    attendeesStateBreakdown: [{ state: "california", percentage: 100 }],
    aggregatedTransactions: [
      { date: "2026-06", subcategoriesBreakdown: [{ subcategory: "catering", tonsCo2e: 1.5 }] }
    ]
  });
  assertSuccessEnvelope(env);
  assert.ok(Math.abs(env.result.totalTransactionsTons - 1.5) < 1e-9);
});
