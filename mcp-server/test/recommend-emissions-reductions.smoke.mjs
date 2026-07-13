import { test } from "node:test";
import assert from "node:assert/strict";

import { handler as recommendReductions } from "../src/tools/recommender/recommendEmissionsReductions.js";

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

const oneRecommendation = (scope) => ({
  title: "Switch office electricity to a renewable tariff",
  description:
    "Move the business's grid electricity onto a certified renewable supply to cut Scope 2 emissions.",
  scope_targeted: scope,
  impact_bucket: "high",
  effort_bucket: "medium",
  first_step: "Contact three renewable REC providers for pricing quotes by end of week"
});

const validRecommendations = (count, scope = "1") =>
  Array(count)
    .fill()
    .map(() => oneRecommendation(scope));

const climateBrainReturning = (text) => async (url) => {
  if (url === CLIMATE_BRAIN_URL) {
    return jsonResponse({ response: text });
  }
  throw new Error(`unexpected fetch to ${url}`);
};

test("recommend_emissions_reductions — exact industry + scopeFocus 1 returns medium-confidence structured envelope", async () => {
  const mockFetch = climateBrainReturning(
    JSON.stringify(validRecommendations(4, "1"))
  );
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 50,
      scopeFocus: "1"
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "medium");
    assert.ok(Array.isArray(env.result.recommendations));
    assert.ok(env.result.recommendations.length >= 3);
    assert.ok(env.result.recommendations.length <= 6);
    assert.equal(env.result.method, "climate_brain_recommendations");
    assert.equal(env.result.raw_text, null);
    assert.equal(env.result.scope_focus, "1");
    assert.equal(env.result.employees, 50);
    assert.equal(env.result.industry_resolved.label, "Restaurants");
    assert.equal(env.result.industry_resolved.naics, 722511);
    assert.equal(env.result.industry_resolved.buildings_slug, "foodService");
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_authored"));
    assert.ok(!env.warnings.find((w) => w.code === "default_used"));
  });
});

test("recommend_emissions_reductions — case-insensitive exact match, scopeFocus defaults to all", async () => {
  const capturedBodies = [];
  const mockFetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return jsonResponse({ response: JSON.stringify(validRecommendations(3)) });
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "restaurants",
      employees: 12
    });
    assert.equal(env.error, null);
    assert.equal(env.result.scope_focus, "all");
    assert.ok(capturedBodies[0].prompt.includes("Scope 1, 2, and 3"));
    assert.ok(!env.warnings.find((w) => w.code === "default_used"));
  });
});

test("recommend_emissions_reductions — non-exact substring match emits default_used warning", async () => {
  const mockFetch = climateBrainReturning(
    JSON.stringify(validRecommendations(3, "3"))
  );
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "software",
      employees: 20,
      scopeFocus: "3"
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "medium");
    assert.ok(env.warnings.find((w) => w.code === "default_used"));
    assert.equal(env.result.industry_resolved.label, "Computer Software / Engineering");
  });
});

test("recommend_emissions_reductions — unknown industry falls back to office / professional services", async () => {
  const capturedBodies = [];
  const mockFetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return jsonResponse({ response: JSON.stringify(validRecommendations(3)) });
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "SaaSyPantsRunners",
      employees: 20,
      scopeFocus: "3"
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "low");
    assert.ok(env.warnings.find((w) => w.code === "default_used"));
    assert.equal(env.result.industry_resolved.label, null);
    assert.equal(env.result.industry_resolved.buildings_slug, "office");
    assert.ok(capturedBodies[0].prompt.includes("office / professional services"));
    assert.ok(!capturedBodies[0].prompt.includes("SaaSyPantsRunners"));
  });
});

test("recommend_emissions_reductions — employees over 10000 yields low confidence + SMB-calibration warning", async () => {
  const capturedBodies = [];
  const mockFetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return jsonResponse({ response: JSON.stringify(validRecommendations(3)) });
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 50000
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "low");
    assert.ok(env.warnings.find((w) => w.code === "default_used"));
    assert.ok(capturedBodies[0].prompt.includes("SMB-calibrated"));
  });
});

test("recommend_emissions_reductions — additionalContext woven into prompt", async () => {
  const capturedBodies = [];
  const mockFetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return jsonResponse({ response: JSON.stringify(validRecommendations(3)) });
  };
  await withMockedFetch(mockFetch, async () => {
    await recommendReductions({
      industry: "Restaurants",
      employees: 20,
      additionalContext: "operates 3 locations"
    });
    assert.ok(capturedBodies[0].prompt.includes("operates 3 locations"));
  });
});

test("recommend_emissions_reductions — whitespace-only industry rejected as invalid_input", async () => {
  const env = await recommendReductions({ industry: "   ", employees: 20 });
  assert.equal(env.error.code, "invalid_input");
  assert.equal(env.result, null);
});

test("recommend_emissions_reductions — employees 0 rejected as invalid_input", async () => {
  const env = await recommendReductions({ industry: "Restaurants", employees: 0 });
  assert.equal(env.error.code, "invalid_input");
});

test("recommend_emissions_reductions — invalid scopeFocus rejected as invalid_input", async () => {
  const env = await recommendReductions({
    industry: "Restaurants",
    employees: 20,
    scopeFocus: "invalid"
  });
  assert.equal(env.error.code, "invalid_input");
});

test("recommend_emissions_reductions — unparseable prose falls back to raw_text + parse-failed warning", async () => {
  const prose = "here are some ideas: 1. do a thing 2. do another thing";
  const mockFetch = climateBrainReturning(prose);
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "low");
    assert.equal(env.result.recommendations, null);
    assert.equal(env.result.raw_text, prose);
    assert.equal(env.result.method, "climate_brain_recommendations_prose_fallback");
    assert.ok(
      env.warnings.find((w) => w.code === "structured_output_parse_failed")
    );
  });
});

test("recommend_emissions_reductions — markdown-fenced JSON recovered and parsed", async () => {
  const fenced = "```json\n" + JSON.stringify(validRecommendations(3)) + "\n```";
  const mockFetch = climateBrainReturning(fenced);
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.equal(env.error, null);
    assert.ok(Array.isArray(env.result.recommendations));
    assert.equal(env.result.recommendations.length, 3);
  });
});

test("recommend_emissions_reductions — uppercase JSON code fence recovered and parsed", async () => {
  const fenced = "```JSON\r\n" + JSON.stringify(validRecommendations(3)) + "\r\n```";
  const mockFetch = climateBrainReturning(fenced);
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.equal(env.error, null);
    assert.ok(Array.isArray(env.result.recommendations));
    assert.equal(env.result.recommendations.length, 3);
  });
});

test("recommend_emissions_reductions — fallback industry + large org emits a single combined default_used warning", async () => {
  const mockFetch = climateBrainReturning(JSON.stringify(validRecommendations(3)));
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "SaaSyPantsRunners",
      employees: 50000
    });
    assert.equal(env.error, null);
    const defaultUsed = env.warnings.filter((w) => w.code === "default_used");
    assert.equal(defaultUsed.length, 1);
    assert.ok(defaultUsed[0].message.includes("did not match"));
    assert.ok(defaultUsed[0].message.includes("SMB-calibrated"));
  });
});

test("recommend_emissions_reductions — out-of-range array count treated as parse failure", async () => {
  const mockFetch = climateBrainReturning(
    JSON.stringify(validRecommendations(8))
  );
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.equal(env.error, null);
    assert.equal(env.result.recommendations, null);
    assert.ok(
      env.warnings.find((w) => w.code === "structured_output_parse_failed")
    );
  });
});

test("recommend_emissions_reductions — malformed item shape treated as parse failure", async () => {
  const badShape = JSON.stringify([
    { title: "x", description: "y", scope_targeted: "9", impact_bucket: "high", effort_bucket: "low", first_step: "z" },
    oneRecommendation("1"),
    oneRecommendation("2")
  ]);
  const mockFetch = climateBrainReturning(badShape);
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.equal(env.error, null);
    assert.equal(env.result.recommendations, null);
    assert.ok(
      env.warnings.find((w) => w.code === "structured_output_parse_failed")
    );
  });
});

test("recommend_emissions_reductions — Climate Brain outage returns climate_brain_unavailable 503", async () => {
  const mockFetch = async () => jsonResponse({ error: "boom" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
    assert.equal(env.result, null);
  });
});

test("recommend_emissions_reductions — empty Climate Brain response returns climate_brain_unavailable 503", async () => {
  const mockFetch = climateBrainReturning("");
  await withMockedFetch(mockFetch, async () => {
    const env = await recommendReductions({
      industry: "Restaurants",
      employees: 20
    });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
    assert.equal(env.result, null);
  });
});
