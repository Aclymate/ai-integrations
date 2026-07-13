import { test } from "node:test";
import assert from "node:assert/strict";

import defaultCalcs from "@aclymatepackages/calcs/recurring/defaultCalcs.js";
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

const okAnnotationFetch = (text = "Aclymate's default model uses...") =>
  async (url) => {
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({ response: text });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

test("estimate_emissions — numeric surface comes from @aclymatepackages/calcs (parity with buildDefaultEmissionsObj)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 50,
      location: "Denver, CO"
    });

    assert.equal(env.error, null);
    assert.equal(env.result.method, "calcs_default_emissions");
    assert.equal(env.result.resolved_state, "co");
    assert.equal(env.result.resolved_country, "us");

    const monthly = defaultCalcs.buildDefaultEmissionsObj({
      employeeCount: 50,
      isRemote: false,
      state: "co",
      industry: { label: "Accounting", buildingsSlug: "office", naics: 541219 },
      country: "us"
    });
    const expectedAnnualTotal = monthly.totalMonthlyTons * 12;

    assert.ok(
      Math.abs(env.result.annual_tco2e - expectedAnnualTotal) < 1e-9,
      `annual_tco2e ${env.result.annual_tco2e} != calcs-derived ${expectedAnnualTotal}`
    );
    assert.ok(env.result.annual_tco2e > 0);
    assert.ok(env.result.scope1_gas_tco2e >= 0);
    assert.ok(env.result.scope2_electricity_tco2e >= 0);
    assert.ok(env.result.scope3_commute_tco2e > 0);
  });
});

test("estimate_emissions — factor_snapshot pins @aclymatepackages/calcs", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "consulting firm",
      employees: 10,
      location: "Denver, CO"
    });
    assert.equal(env.factor_snapshot.package, "@aclymatepackages/calcs");
    assert.ok(env.factor_snapshot.version);
    assert.ok(env.sources.length > 0);
    assert.equal(env.attribution.name, "Aclymate");
  });
});

test("estimate_emissions — Climate Brain prose emitted as annotation with climate_brain_authored warning", async () => {
  const proseText = "This estimate uses CBECS 2018 electricity intensity...";
  await withMockedFetch(okAnnotationFetch(proseText), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 25,
      location: "Denver, CO"
    });
    assert.equal(env.result.annotation, proseText);
    assert.ok(
      env.warnings.find((w) => w.code === "climate_brain_authored"),
      "expected climate_brain_authored warning on annotation prose"
    );
    assert.ok(env.result.annual_tco2e > 0);
  });
});

test("estimate_emissions — Climate Brain outage still returns numeric result (no more 503)", async () => {
  const mockFetch = async () => jsonResponse({ error: "down" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await estimateEmissions({
      industry: "retail store",
      employees: 5,
      location: "Colorado"
    });
    assert.equal(env.error, null, "outage must NOT fail the numeric surface");
    assert.ok(env.result.annual_tco2e > 0);
    assert.equal(env.result.annotation, null);
    assert.ok(
      env.warnings.find((w) => w.code === "climate_brain_fallback"),
      "expected climate_brain_fallback warning when annotation is unavailable"
    );
  });
});

test("estimate_emissions — no location supplied → default_used warning + Delaware anchor", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 12
    });
    assert.equal(env.error, null);
    assert.equal(env.result.location, null);
    assert.equal(env.result.resolved_state, "de");
    assert.ok(
      env.warnings.find(
        (w) => w.code === "default_used" && /Delaware/.test(w.message)
      ),
      "expected default_used warning citing Delaware overshoot fallback"
    );
  });
});

test("estimate_emissions — locationless overshoots location-anchored (higher tCO2e)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const noLocation = await estimateEmissions({
      industry: "Accounting",
      employees: 10
    });
    const inColorado = await estimateEmissions({
      industry: "Accounting",
      employees: 10,
      location: "Colorado"
    });
    assert.ok(
      noLocation.result.annual_tco2e > inColorado.result.annual_tco2e,
      `locationless (${noLocation.result.annual_tco2e}) should overshoot Colorado (${inColorado.result.annual_tco2e})`
    );
    assert.equal(noLocation.result.resolved_state, "de");
    assert.equal(inColorado.result.resolved_state, "co");
  });
});

test("estimate_emissions — unrecognized industry falls back to office building + default_used warning", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "zzzzz-not-a-real-industry-xyz",
      employees: 20,
      location: "Colorado"
    });
    assert.equal(env.error, null);
    assert.equal(env.result.matched_industry_label, null);
    assert.ok(env.warnings.find((w) => w.code === "default_used"));
    assert.ok(env.result.annual_tco2e > 0);
  });
});

test("estimate_emissions — unresolved location → unknown_region warning + Delaware anchor", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 8,
      location: "Atlantis"
    });
    assert.equal(env.error, null);
    assert.equal(env.result.resolved_state, "de");
    assert.ok(
      env.warnings.find(
        (w) => w.code === "unknown_region" && /Delaware/.test(w.message)
      )
    );
    assert.equal(env.confidence, "low");
  });
});

test("estimate_emissions — matched industry label surfaced on the result (exact match, no warning)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "accounting",
      employees: 50,
      location: "Denver, CO"
    });
    assert.equal(env.result.matched_industry_label, "Accounting");
    assert.equal(
      env.warnings.find((w) => /matched to Aclymate/.test(w.message ?? "")),
      undefined,
      "exact match must NOT emit a substring/PDL match warning"
    );
    assert.equal(env.confidence, "high", "exact match + exact state → high confidence");
  });
});

test("estimate_emissions — substring-matched industry emits default_used warning + medium confidence (Fix 5)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    // "restaurant" (singular) is not an exact label but is a substring of "Restaurants" (plural)
    const env = await estimateEmissions({
      industry: "restaurant",
      employees: 10,
      location: "Denver, CO"
    });
    assert.equal(env.error, null);
    assert.equal(
      env.result.matched_industry_label,
      "Restaurants",
      "substring match should surface the matched label"
    );
    const warn = env.warnings.find(
      (w) =>
        w.code === "default_used" &&
        /via substring lookup/.test(w.message)
    );
    assert.ok(
      warn,
      "expected default_used warning citing substring lookup + matched label"
    );
    assert.equal(
      env.confidence,
      "medium",
      "non-exact industry match should drop confidence from high to medium"
    );
  });
});

test("estimate_emissions — whitespace-only industry rejected as invalid_input (Fix 1)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "   ",
      employees: 10,
      location: "Denver, CO"
    });
    assert.ok(env.error, "whitespace-only industry must fail Zod validation");
    assert.equal(env.error.code, "invalid_input");
    assert.equal(env.result, null);
  });
});

test("estimate_emissions — 'he lives in Denver' does NOT get tagged as Indiana (Fix 2)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 8,
      location: "he lives in Denver"
    });
    assert.notEqual(
      env.result.resolved_state,
      "in",
      "'in' inside prose must not resolve to Indiana"
    );
  });
});

test("estimate_emissions — 'hi there' does NOT get tagged as Hawaii (Fix 2)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 8,
      location: "hi there we're a business"
    });
    assert.notEqual(
      env.result.resolved_state,
      "hi",
      "'hi' inside prose must not resolve to Hawaii"
    );
  });
});

test("estimate_emissions — 'Denver, CO' still resolves to Colorado via comma path (Fix 2 doesn't regress)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 8,
      location: "Denver, CO"
    });
    assert.equal(env.result.resolved_state, "co");
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

test("estimate_emissions — scope breakdown sums to annual total (within rounding)", async () => {
  await withMockedFetch(okAnnotationFetch(), async () => {
    const env = await estimateEmissions({
      industry: "Accounting",
      employees: 30,
      location: "Colorado"
    });
    const sum =
      env.result.scope1_gas_tco2e +
      env.result.scope2_electricity_tco2e +
      env.result.scope3_commute_tco2e;
    assert.ok(
      Math.abs(sum - env.result.annual_tco2e) < 1e-6,
      `scope sum ${sum} !== annual_tco2e ${env.result.annual_tco2e}`
    );
  });
});
