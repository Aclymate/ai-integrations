import { test } from "node:test";
import assert from "node:assert/strict";

import defaultCalcs from "@aclymatepackages/calcs/recurring/defaultCalcs.js";
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

const okAnnotationFetch = (text = "Top performers procure renewables...") =>
  async (url) => {
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({ response: text });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

test("compare_business_footprint — benchmark tCO2e comes from @aclymatepackages/calcs (parity with buildDefaultEmissionsObj)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Denver, CO"
    });
    assert.equal(env.error, null);
    assert.equal(env.result.method, "calcs_default_emissions_benchmark");

    const monthly = defaultCalcs.buildDefaultEmissionsObj({
      employeeCount: 25,
      isRemote: false,
      state: "co",
      industry: { label: "Accounting", buildingsSlug: "office", naics: 541219 },
      country: "us"
    });
    const expected = monthly.totalMonthlyTons * 12;

    assert.ok(
      Math.abs(env.result.benchmark_annual_tco2e - expected) < 1e-9,
      `benchmark ${env.result.benchmark_annual_tco2e} != calcs-derived ${expected}`
    );
    assert.ok(env.result.benchmark_annual_tco2e > 0);
  });
});

test("compare_business_footprint — factor_snapshot pins @aclymatepackages/calcs", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await compareFootprint({
      industry: "consulting firm",
      employees: 10,
      location: "Colorado"
    });
    assert.equal(env.factor_snapshot.package, "@aclymatepackages/calcs");
    assert.ok(env.factor_snapshot.version);
    assert.ok(env.sources.length > 0);
    assert.equal(env.attribution.name, "Aclymate");
  });
});

test("compare_business_footprint — no totalTonsCo2e supplied → pct_vs_benchmark null, posture null", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await compareFootprint({
      industry: "retail store",
      employees: 8,
      location: "Colorado"
    });
    assert.equal(env.result.totalTonsCo2e, null);
    assert.equal(env.result.pct_vs_benchmark, null);
    assert.equal(env.result.posture, null);
  });
});

test("compare_business_footprint — actual > 15% above benchmark → posture=above_peers", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const preview = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado"
    });
    const inflated = preview.result.benchmark_annual_tco2e * 1.5;

    const env = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado",
      totalTonsCo2e: inflated
    });
    assert.equal(env.result.posture, "above_peers");
    assert.ok(env.result.pct_vs_benchmark > 15);
  });
});

test("compare_business_footprint — actual > 15% below benchmark → posture=below_peers", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const preview = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado"
    });
    const deflated = preview.result.benchmark_annual_tco2e * 0.5;

    const env = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado",
      totalTonsCo2e: deflated
    });
    assert.equal(env.result.posture, "below_peers");
    assert.ok(env.result.pct_vs_benchmark < -15);
  });
});

test("compare_business_footprint — actual within ±15% of benchmark → posture=in_line", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const preview = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado"
    });
    const nearBenchmark = preview.result.benchmark_annual_tco2e * 1.05;

    const env = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado",
      totalTonsCo2e: nearBenchmark
    });
    assert.equal(env.result.posture, "in_line");
  });
});

test("compare_business_footprint — Climate Brain prose emitted as annotation with climate_brain_authored warning", async () => {
  const proseText = "Top performers procure 100% renewables and...";
  await withMockedFetch(okAnnotationFetch(proseText), async () => {
    const env = await compareFootprint({
      industry: "Accounting",
      employees: 25,
      location: "Colorado"
    });
    assert.equal(env.result.annotation, proseText);
    assert.ok(
      env.warnings.find((w) => w.code === "climate_brain_authored"),
      "expected climate_brain_authored warning on annotation prose"
    );
  });
});

test("compare_business_footprint — Climate Brain outage still returns numeric benchmark (no more 503)", async () => {
  const mockFetch = async () => jsonResponse({ error: "down" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await compareFootprint({
      industry: "law firm",
      employees: 15,
      location: "Colorado"
    });
    assert.equal(env.error, null, "outage must NOT fail the numeric surface");
    assert.ok(env.result.benchmark_annual_tco2e > 0);
    assert.equal(env.result.annotation, null);
    assert.ok(
      env.warnings.find((w) => w.code === "climate_brain_fallback"),
      "expected climate_brain_fallback warning when annotation is unavailable"
    );
  });
});

test("compare_business_footprint — no location supplied → default_used + Colorado anchor", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await compareFootprint({
      industry: "Accounting",
      employees: 8
    });
    assert.equal(env.result.location, null);
    assert.equal(env.result.resolved_state, "co");
    assert.ok(
      env.warnings.find(
        (w) => w.code === "default_used" && /Colorado/.test(w.message)
      )
    );
  });
});

test("compare_business_footprint — unresolved location → unknown_region warning + Colorado anchor", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await compareFootprint({
      industry: "Accounting",
      employees: 12,
      location: "Atlantis"
    });
    assert.equal(env.result.resolved_state, "co");
    assert.ok(env.warnings.find((w) => w.code === "unknown_region"));
    assert.equal(env.confidence, "low");
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
