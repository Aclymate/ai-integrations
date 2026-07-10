import { test } from "node:test";
import assert from "node:assert/strict";

import { handler as estimateEmissions } from "../src/tools/estimateEmissions.js";

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

test("estimate_emissions — canonical case returns low-confidence envelope + CLIMATE_BRAIN_ESTIMATE warning", async () => {
  const mockFetch = async (url) => {
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({
        response: "For a 50-person consulting firm, expect ~50-100 tCO2e/year..."
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await estimateEmissions({
      industry: "consulting firm",
      employees: 50
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "low");
    assert.equal(env.result.method, "climate_brain_estimate");
    assert.equal(env.result.industry, "consulting firm");
    assert.equal(env.result.employees, 50);
    assert.equal(env.result.location, null);
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_estimate"));
    assert.equal(env.factor_snapshot, null);
  });
});

test("estimate_emissions — location preserved in result", async () => {
  const mockFetch = async () =>
    jsonResponse({ response: "Restaurant in Denver..." });
  await withMockedFetch(mockFetch, async () => {
    const env = await estimateEmissions({
      industry: "restaurant",
      employees: 12,
      location: "Denver, CO"
    });
    assert.equal(env.result.location, "Denver, CO");
  });
});

test("estimate_emissions — Climate Brain outage returns CLIMATE_BRAIN_UNAVAILABLE error", async () => {
  const mockFetch = async () => jsonResponse({ error: "down" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await estimateEmissions({
      industry: "retail store",
      employees: 5
    });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
  });
});

test("estimate_emissions — missing industry rejected as invalid_input", async () => {
  const env = await estimateEmissions({ employees: 10 });
  assert.equal(env.error.code, "invalid_input");
});

test("estimate_emissions — non-positive employees rejected as invalid_input", async () => {
  const env = await estimateEmissions({ industry: "law firm", employees: 0 });
  assert.equal(env.error.code, "invalid_input");
});
