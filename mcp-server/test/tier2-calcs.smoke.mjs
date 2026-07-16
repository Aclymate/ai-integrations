import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handler as classifyVendor
} from "../src/tools/tier2/classifyVendorByIndustry.js";
import {
  handler as calcRefrigerant
} from "../src/tools/tier2/calculateRefrigerantEmissions.js";
import { handler as calcSteam } from "../src/tools/tier2/calculateSteamEmissions.js";
import { handler as calcWater } from "../src/tools/tier2/calculateWaterEmissions.js";
import {
  handler as calcVehicle
} from "../src/tools/tier2/calculateVehicleEmissions.js";
import {
  handler as calcShipping
} from "../src/tools/tier2/calculateShippingEmissions.js";
import {
  handler as calcCommute
} from "../src/tools/tier2/calculateCommuteEmissions.js";
import {
  handler as calcOfficeUtility
} from "../src/tools/tier2/calculateOfficeUtilityEmissions.js";
import { resolveVehicleFactor } from "../src/tools/tier2/vehicleFactorLookup.js";
import { detectSourceAgent } from "../src/middleware/sourceAgent.js";
import commuteCalcs from "@aclymatepackages/calcs/recurring/commuting.js";

const { commuteTonsFromDistance } = commuteCalcs;

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

test("classify_vendor_by_industry — no industryHint: no_industry_match + low confidence", async () => {
  const env = await classifyVendor({ vendorName: "Acme Corp" });
  assertSuccessEnvelope(env);
  assert.equal(env.result.vendorName, "Acme Corp");
  assert.equal(env.confidence, "low");
  assert.ok(env.warnings.find((w) => w.code === "no_industry_match"));
});

test("calculate_refrigerant_emissions — happy path", async () => {
  const env = await calcRefrigerant({ quantity: 10, unit: "lbs", refrigerantType: "r410a" });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
});

test("calculate_refrigerant_emissions — invalid refrigerantType rejected", async () => {
  const env = await calcRefrigerant({ quantity: 10, unit: "lbs", refrigerantType: "co2" });
  assertErrorEnvelope(env, "invalid_input");
});

test("calculate_steam_emissions — happy path", async () => {
  const env = await calcSteam({ quantity: 100, unit: "lbs" });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
});

test("calculate_water_emissions — with wastewaterPercentage is additive", async () => {
  const withoutWastewater = await calcWater({ quantity: 1000, unit: "gallons" });
  const withWastewater = await calcWater({
    quantity: 1000,
    unit: "gallons",
    wastewaterPercentage: 50
  });
  assertSuccessEnvelope(withoutWastewater);
  assertSuccessEnvelope(withWastewater);
  assert.equal(withoutWastewater.result.wastewater_tCO2e, null);
  assert.ok(withWastewater.result.wastewater_tCO2e > 0);
  assert.ok(withWastewater.result.tCO2e > withoutWastewater.result.tCO2e);
});

test("calculate_vehicle_emissions — exact make/model/year: high confidence", async () => {
  const env = await calcVehicle({ make: "Mazda", model: "CX-5", year: 2023, distanceMi: 100 });
  assertSuccessEnvelope(env);
  assert.equal(env.confidence, "high");
  assert.equal(env.warnings.length, 0);
  assert.ok(Math.abs(env.result.tCO2e - 0.0353500) < 1e-6);
  assert.ok(env.sources[0].factor_id);
});

test("calculate_vehicle_emissions — year beyond EFDB range falls back to nearest year", async () => {
  const env = await calcVehicle({ make: "Mazda", model: "CX-5", year: 2025, distanceMi: 100 });
  assertSuccessEnvelope(env);
  assert.equal(env.confidence, "medium");
  assert.ok(env.warnings.find((w) => w.code === "vehicle_year_fallback"));
});

test("calculate_vehicle_emissions — no make/model: blended default", async () => {
  const env = await calcVehicle({ distanceMi: 100 });
  assertSuccessEnvelope(env);
  assert.equal(env.confidence, "medium");
  assert.ok(env.warnings.find((w) => w.code === "default_vehicle_used"));
});

test("calculate_vehicle_emissions — make/model given but no year: newest year, no fallback warning", async () => {
  const env = await calcVehicle({ make: "Mazda", model: "CX-5", distanceMi: 100 });
  assertSuccessEnvelope(env);
  assert.equal(env.confidence, "high");
  assert.equal(env.warnings.length, 0);
  assert.equal(env.result.year, 2023);
});

test("resolveVehicleFactor — no year requested resolves to newest year as exact match", () => {
  const lookup = resolveVehicleFactor({ make: "Mazda", model: "CX-5" });
  assert.equal(lookup.match, "exact");
  assert.equal(lookup.row.keys.vehicle_year, 2023);
});

test("calculate_shipping_emissions — happy path", async () => {
  const env = await calcShipping({ distanceMi: 500, weightTons: 2, travelMethod: "road" });
  assertSuccessEnvelope(env);
  assert.ok(env.result.tCO2e > 0);
});

test("calculate_commute_emissions — daysPerWeek out of range rejected (no silent clamp)", async () => {
  const env = await calcCommute({ oneWayDistanceMi: 15, daysPerWeek: 8 });
  assertErrorEnvelope(env, "invalid_input");
  const envNegative = await calcCommute({ oneWayDistanceMi: 15, daysPerWeek: -1 });
  assertErrorEnvelope(envNegative, "invalid_input");
});

test("calculate_commute_emissions — matches the shared commuteTonsFromDistance kernel", async () => {
  const env = await calcCommute({ oneWayDistanceMi: 15, daysPerWeek: 3 });
  assertSuccessEnvelope(env);
  const expected = commuteTonsFromDistance({
    tonsCo2ePerMile: 0.0004262787,
    oneWayDistanceMi: 15,
    daysPerWeek: 3,
    monthFraction: 1
  });
  assert.ok(Math.abs(env.result.tCO2e - expected) < 1e-9);
});

test("calculate_office_utility_emissions — omits absent utility types rather than zeroing", async () => {
  const env = await calcOfficeUtility({
    utilities: [{ type: "gas", quantity: 100, unit: "therms" }]
  });
  assertSuccessEnvelope(env);
  assert.ok("gas" in env.result.breakdown);
  assert.ok(!("electric" in env.result.breakdown));
  assert.ok(!("water" in env.result.breakdown));
});

test("resolveVehicleFactor — unknown make returns no match", () => {
  const lookup = resolveVehicleFactor({ make: "Zorp", model: "Blah", year: 2020 });
  assert.equal(lookup.match, "none");
});

test("detectSourceAgent — scout header wins over everything", () => {
  const req = {
    headers: {
      "x-aclymate-scout-auth": "1",
      "x-aclymate-source": "claude",
      "user-agent": "chatgpt-bot/1.0"
    }
  };
  assert.equal(detectSourceAgent(req, { pendingScoutAuth: false }), "scout");
});

test("detectSourceAgent — explicit x-aclymate-source header wins over User-Agent", () => {
  const req = {
    headers: { "x-aclymate-source": "gemini", "user-agent": "claude-desktop/1.0" }
  };
  assert.equal(detectSourceAgent(req, null), "gemini");
});

test("detectSourceAgent — unknown x-aclymate-source header falls through to User-Agent", () => {
  const req = {
    headers: { "x-aclymate-source": "bogus", "user-agent": "chatgpt-actions" }
  };
  assert.equal(detectSourceAgent(req, null), "chatgpt");
});

test("detectSourceAgent — no signals at all defaults to unknown", () => {
  assert.equal(detectSourceAgent({ headers: {} }, null), "unknown");
});
