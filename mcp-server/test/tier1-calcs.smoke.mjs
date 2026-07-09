import { test } from "node:test";
import assert from "node:assert/strict";

import {
  definition as flightDef,
  handler as flight
} from "../src/tools/calcs/tier1/calculateFlightEmissions.js";
import {
  definition as trainDef,
  handler as train
} from "../src/tools/calcs/tier1/calculateTrainEmissions.js";
import {
  definition as otherTransportDef,
  handler as otherTransport
} from "../src/tools/calcs/tier1/calculateOtherTransportEmissions.js";
import {
  definition as electricityDef,
  handler as electricity
} from "../src/tools/calcs/tier1/calculateElectricityEmissions.js";
import {
  definition as gasDef,
  handler as gas
} from "../src/tools/calcs/tier1/calculateGasEmissions.js";
import {
  definition as dietDef,
  handler as diet
} from "../src/tools/calcs/tier1/calculateDietEmissions.js";
import {
  definition as petDef,
  handler as pet
} from "../src/tools/calcs/tier1/calculatePetEmissions.js";

const assertSuccessEnvelope = (env) => {
  assert.equal(env.error, null, `expected error===null, got ${JSON.stringify(env.error)}`);
  assert.ok(env.result, "expected result to be populated");
  assert.equal(env.attribution.name, "Aclymate");
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

test("flight — happy path with explicit distance", async () => {
  const env = await flight({ distance: 5000, passClass: "economy" });
  assertSuccessEnvelope(env);
  assert.equal(env.result.method, "distance");
  assert.equal(env.confidence, "high");
  assert.equal(env.warnings.length, 0);
  assert.ok(env.result.tCO2e > 0);
});

test("flight — no distance or coordinates: default_used warning + low-ish confidence", async () => {
  const env = await flight({});
  assertSuccessEnvelope(env);
  assert.equal(env.result.method, "default");
  assert.ok(env.warnings.find((w) => w.code === "default_used"));
});

test("train — happy path", async () => {
  const env = await train({ mileage: 200, trainType: "intercityRail" });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
});

test("train — isNortheastCorridor overrides trainType", async () => {
  const env = await train({
    mileage: 200,
    trainType: "lightRail",
    isNortheastCorridor: true
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result.method, "northeastCorridor");
  assert.ok(env.warnings.find((w) => w.code === "nec_overrides_train_type"));
});

test("other-transport — walkBike is definitional zero", async () => {
  const env = await otherTransport({
    transportationType: "walkBike",
    mileage: 5
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result.tCO2e, 0);
  assert.equal(env.confidence, null);
});

test("other-transport — unknown type rejected (no silent zero)", async () => {
  const env = await otherTransport({ transportationType: "hoverboard", mileage: 5 });
  assertErrorEnvelope(env, "invalid_transport_type");
});

test("electricity — default eGrid emits conservative_default warning", async () => {
  const env = await electricity({ unitValue: 1000, unit: "kwh" });
  assertSuccessEnvelope(env);
  assert.ok(env.warnings.find((w) => w.code === "conservative_default"));
  assert.equal(env.result.eGrid, "MROE");
});

test("electricity — invalid unit rejected", async () => {
  const env = await electricity({ unitValue: 1000, unit: "joules" });
  assertErrorEnvelope(env, "invalid_input");
});

test("electricity — past year picks closest available data year", async () => {
  const env = await electricity({
    unitValue: 1000,
    unit: "kwh",
    eGrid: "CAMX",
    date: "2020-06-15"
  });
  assertSuccessEnvelope(env);
  assert.ok(env.result.data_year <= 2020);
});

test("gas — natural gas therms happy path", async () => {
  const env = await gas({
    fuelType: "naturalGas",
    unit: "therms",
    unitValue: 200
  });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
});

test("gas — invalid (fuelType, unit) pair rejected at Zod time", async () => {
  const env = await gas({ fuelType: "wood", unit: "therms", unitValue: 5 });
  assertErrorEnvelope(env, "invalid_input");
});

test("gas — case-wrong fuelType rejected (no case normalization)", async () => {
  const env = await gas({
    fuelType: "natural_gas",
    unit: "therms",
    unitValue: 200
  });
  assertErrorEnvelope(env, "invalid_input");
});

test("diet — SAD happy path returns monthly + annual", async () => {
  const env = await diet({ dietType: "sad", numPeople: 2 });
  assertSuccessEnvelope(env);
  assert.ok(env.result.monthly_tco2e > 0);
  assert.ok(
    Math.abs(env.result.annual_tco2e - env.result.monthly_tco2e * 12) < 1e-9
  );
});

test("diet — unknown dietType rejected", async () => {
  const env = await diet({ dietType: "vegan" });
  assertErrorEnvelope(env, "invalid_input");
});

test("pet — all zeros is a valid answer (no warning)", async () => {
  const env = await pet({});
  assertSuccessEnvelope(env);
  assert.equal(env.result.monthly_tco2e, 0);
  assert.equal(env.warnings.length, 0);
});

test("pet — negative count rejected", async () => {
  const env = await pet({ numDogs: -1 });
  assertErrorEnvelope(env, "invalid_input");
});

test("pet — breakdown adds up to monthly total", async () => {
  const env = await pet({ numDogs: 1, numCats: 2, numLargeDogs: 1 });
  assertSuccessEnvelope(env);
  const sum =
    env.result.breakdown.monthly_dogs_tco2e +
    env.result.breakdown.monthly_cats_tco2e +
    env.result.breakdown.monthly_large_dogs_tco2e;
  assert.ok(Math.abs(sum - env.result.monthly_tco2e) < 1e-9);
});

test("NaN input rejected on flight distance", async () => {
  const env = await flight({ distance: Number.NaN, passClass: "economy" });
  assertErrorEnvelope(env, "invalid_input");
});

test("flight — coordinates path produces method=coordinates", async () => {
  const env = await flight({
    to: { lat: 40.6413, lng: -73.7781 },
    from: { lat: 33.9416, lng: -118.4085 },
    passClass: "economy"
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result.method, "coordinates");
  assert.ok(env.result.distance_km > 0);
});

test("flight — passClass omitted emits class_defaulted warning", async () => {
  const env = await flight({ distance: 5000 });
  assertSuccessEnvelope(env);
  assert.ok(env.warnings.find((w) => w.code === "class_defaulted"));
  assert.equal(env.confidence, "medium");
});

test("train — no trainType and not NEC emits train_type_defaulted", async () => {
  const env = await train({ mileage: 100 });
  assertSuccessEnvelope(env);
  assert.ok(env.warnings.find((w) => w.code === "train_type_defaulted"));
});

test("electricity — unrecognized region emits unknown_region + low confidence", async () => {
  const env = await electricity({
    unitValue: 1000,
    unit: "kwh",
    eGrid: "Atlantis"
  });
  assertSuccessEnvelope(env);
  assert.ok(env.warnings.find((w) => w.code === "unknown_region"));
  assert.equal(env.confidence, "low");
  assert.equal(env.result.data_year, null);
});

test("electricity — recognized country classifies as country (no unknown_region)", async () => {
  const env = await electricity({
    unitValue: 1000,
    unit: "kwh",
    eGrid: "germany"
  });
  assertSuccessEnvelope(env);
  assert.equal(env.warnings.find((w) => w.code === "unknown_region"), undefined);
  assert.equal(env.result.data_year, null);
});

test("other-transport — invalid transportationType returns invalid_transport_type", async () => {
  const env = await otherTransport({ transportationType: "hoverboard", mileage: 5 });
  assertErrorEnvelope(env, "invalid_transport_type");
});

test("other-transport — bad mileage returns invalid_input (not invalid_transport_type)", async () => {
  const env = await otherTransport({
    transportationType: "bus",
    mileage: -5
  });
  assertErrorEnvelope(env, "invalid_input");
});

test("all 7 definitions expose {name, title, description}", () => {
  const defs = [
    flightDef,
    trainDef,
    otherTransportDef,
    electricityDef,
    gasDef,
    dietDef,
    petDef
  ];
  for (const def of defs) {
    assert.ok(def.name);
    assert.ok(def.title);
    assert.ok(def.description);
  }
});
