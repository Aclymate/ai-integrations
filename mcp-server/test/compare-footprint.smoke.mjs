import { test } from "node:test";
import assert from "node:assert/strict";

import { handler as compareFootprint } from "../src/tools/compareFootprint.js";

const CLIMATE_BRAIN_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/knowledgeCompose";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const withMockedFetch = (mockFn, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
};

test("compare_business_footprint — without totalTonsCo2e returns benchmark envelope + CLIMATE_BRAIN_BENCHMARK warning", async () => {
  const mockFetch = async (url) => {
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({
        response: "A 25-person retail store typically ranges 40-80 tCO2e/year..."
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await compareFootprint({
      industry: "retail store",
      employees: 25
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "low");
    assert.equal(env.result.method, "climate_brain_benchmark");
    assert.equal(env.result.industry, "retail store");
    assert.equal(env.result.employees, 25);
    assert.equal(env.result.totalTonsCo2e, null);
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_benchmark"));
    assert.equal(env.factor_snapshot, null);
  });
});

test("compare_business_footprint — with totalTonsCo2e returns envelope preserving the value", async () => {
  const mockFetch = async () =>
    jsonResponse({ response: "Above peers by ~15%..." });
  await withMockedFetch(mockFetch, async () => {
    const env = await compareFootprint({
      industry: "consulting firm",
      employees: 50,
      totalTonsCo2e: 120
    });
    assert.equal(env.error, null);
    assert.equal(env.result.totalTonsCo2e, 120);
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_benchmark"));
  });
});

test("compare_business_footprint — Climate Brain outage returns CLIMATE_BRAIN_UNAVAILABLE error", async () => {
  const mockFetch = async () => jsonResponse({ error: "down" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await compareFootprint({
      industry: "law firm",
      employees: 15
    });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
  });
});

test("compare_business_footprint — missing industry rejected as invalid_input", async () => {
  const env = await compareFootprint({ employees: 10 });
  assert.equal(env.error.code, "invalid_input");
});

test("compare_business_footprint — negative employees rejected as invalid_input", async () => {
  const env = await compareFootprint({ industry: "cafe", employees: -1 });
  assert.equal(env.error.code, "invalid_input");
});
