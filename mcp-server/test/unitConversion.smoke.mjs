import { test } from "node:test";
import assert from "node:assert/strict";

import { convertValueUnit } from "../src/tools/unitConversion.js";

test("convertValueUnit — distance: passenger-km -> passenger-mile scales up correctly", () => {
  const result = convertValueUnit(0.25355, "kg CO2/passenger-km", "per mile");
  assert.equal(result.status, "converted");
  assert.ok(
    Math.abs(result.value - 0.25355 * 1.609344) < 1e-9,
    `expected ~${0.25355 * 1.609344}, got ${result.value}`
  );
  assert.equal(result.unit, "kg CO2/passenger-mile");
});

test("convertValueUnit — energy: g CO2/kWh -> g CO2/MWh scales by 1000", () => {
  const result = convertValueUnit(386.6, "g CO2/kWh", "per MWh");
  assert.equal(result.status, "converted");
  assert.ok(Math.abs(result.value - 386600) < 1e-6);
  assert.equal(result.unit, "g CO2/MWh");
});

test("convertValueUnit — mass: kg CO2e/kg refrigerant -> kg CO2e/lb refrigerant", () => {
  const result = convertValueUnit(2088, "kg CO2e/kg refrigerant", "per lb");
  assert.equal(result.status, "converted");
  assert.ok(Math.abs(result.value - 2088 * 0.45359237) < 1e-6);
  assert.equal(result.unit, "kg CO2e/lb refrigerant");
});

test("convertValueUnit — requesting the unit already in use reports already_native, no fabricated value", () => {
  const result = convertValueUnit(386.6, "g CO2/kWh", "per kWh");
  assert.equal(result.status, "already_native");
  assert.equal(result.value, undefined);
});

test("convertValueUnit — dimensionally incompatible request (per-gallon factor asked for per-mile) is honestly incompatible", () => {
  const result = convertValueUnit(10.21, "kg CO2/gallon", "per mile");
  assert.equal(result.status, "incompatible");
});

test("convertValueUnit — nonsense/unrecognized requested unit is incompatible, not silently ignored", () => {
  const result = convertValueUnit(0.01, "tCO2e/ton", "per widget");
  assert.equal(result.status, "incompatible");
});

test("convertValueUnit — ton-mile shipping factor converts to ton-km", () => {
  const result = convertValueUnit(0.186, "kg CO2/ton-mile", "per km");
  assert.equal(result.status, "converted");
  assert.ok(Math.abs(result.value - 0.186 / 1.609344) < 1e-9);
  assert.equal(result.unit, "kg CO2/ton-km");
});
