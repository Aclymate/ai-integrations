import { test } from "node:test";
import assert from "node:assert/strict";

import { handler as getEmissionFactor } from "../src/tools/getEmissionFactor.js";

const CLIMATE_BRAIN_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/knowledgeCompose";
const FACTORS_LOOKUP_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/factorsLookup";

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

const assertSuccessEnvelope = (env) => {
  assert.equal(env.error, null);
  assert.equal(env.attribution.name, "Aclymate");
  assert.ok(Array.isArray(env.warnings));
};

test("get_emission_factor — canonical hit returns structured envelope with high confidence", async () => {
  const mockFetch = async (url) => {
    if (url === FACTORS_LOOKUP_URL) {
      return jsonResponse({
        match: {
          factor_id: "egrid-akgd-2019",
          factor_type: "egrid",
          value: 500.5,
          units: "g CO2/kWh",
          source: {
            name: "EPA eGRID",
            citation: "eGRID 2019",
            url: "https://www.epa.gov/egrid",
            vintage_year: 2019
          },
          package_version: "1.7.1"
        },
        disambiguation_hint: null
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await getEmissionFactor({
      activity: "US average electricity in Alaska in 2019"
    });
    assertSuccessEnvelope(env);
    assert.equal(env.result.factor_id, "egrid-akgd-2019");
    assert.equal(env.result.factor_type, "egrid");
    assert.equal(env.confidence, "high");
    assert.equal(env.warnings.length, 0);
    assert.equal(env.factor_snapshot.package, "@aclymatepackages/emissions-factors");
    assert.equal(env.result.value_block.value, 500.5);
  });
});

test("get_emission_factor — canonical hit with disambiguation_hint emits DISAMBIGUATION_HINT warning", async () => {
  const mockFetch = async (url) => {
    if (url === FACTORS_LOOKUP_URL) {
      return jsonResponse({
        match: {
          factor_id: "egrid-akgd-2019",
          factor_type: "egrid",
          value: 500.5,
          units: "g CO2/kWh",
          source: { name: "EPA eGRID", vintage_year: 2019 },
          package_version: "1.7.1"
        },
        disambiguation_hint: ["egrid-akgd-2018", "egrid-akgd-2016"]
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await getEmissionFactor({ activity: "alaska electricity" });
    assertSuccessEnvelope(env);
    assert.ok(env.warnings.find((w) => w.code === "disambiguation_hint"));
    assert.deepEqual(env.result.disambiguation_hint, [
      "egrid-akgd-2018",
      "egrid-akgd-2016"
    ]);
  });
});

test("get_emission_factor — Climate Brain fallback returns low-confidence envelope + CLIMATE_BRAIN_FALLBACK warning", async () => {
  const mockFetch = async (url) => {
    if (url === FACTORS_LOOKUP_URL) {
      return jsonResponse({ match: null });
    }
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({
        response:
          "The emission factor for widget production is approximately 0.5 kg CO2e per widget."
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await getEmissionFactor({ activity: "widget production" });
    assertSuccessEnvelope(env);
    assert.equal(env.confidence, "low");
    assert.equal(env.result.method, "climate_brain_fallback");
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_fallback"));
    assert.equal(env.factor_snapshot, null);
    assert.ok(env.result.text.includes("widget"));
  });
});

test("get_emission_factor — Climate Brain outage on lookup miss returns CLIMATE_BRAIN_UNAVAILABLE error envelope", async () => {
  const mockFetch = async (url) => {
    if (url === FACTORS_LOOKUP_URL) {
      return jsonResponse({ match: null });
    }
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({ error: "down" }, 503);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await getEmissionFactor({ activity: "widget production" });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
    assert.equal(env.result, null);
  });
});

test("get_emission_factor — missing activity rejected as invalid_input", async () => {
  const env = await getEmissionFactor({});
  assert.equal(env.error.code, "invalid_input");
});

test("get_emission_factor — factorsLookup throws → falls through to Climate Brain", async () => {
  const mockFetch = async (url) => {
    if (url === FACTORS_LOOKUP_URL) {
      return jsonResponse({ error: "boom" }, 500);
    }
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({ response: "fallback text" });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await getEmissionFactor({ activity: "anything" });
    assertSuccessEnvelope(env);
    assert.equal(env.confidence, "low");
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_fallback"));
  });
});
