import { test } from "node:test";
import assert from "node:assert/strict";

import { handler as explainScope } from "../src/tools/explainScope.js";

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

test("explain_scope — canonical case returns medium-confidence envelope + CLIMATE_BRAIN_AUTHORED warning", async () => {
  const mockFetch = async (url) => {
    if (url === CLIMATE_BRAIN_URL) {
      return jsonResponse({
        response:
          "Scope 2 emissions include purchased electricity for a restaurant..."
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  await withMockedFetch(mockFetch, async () => {
    const env = await explainScope({ scope: "2", industry: "restaurant" });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "medium");
    assert.equal(env.result.scope, "2");
    assert.equal(env.result.industry, "restaurant");
    assert.ok(env.result.explanation_text.includes("Scope 2"));
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_authored"));
    assert.equal(env.factor_snapshot, null);
    assert.equal(env.upgrade_hint, null);
  });
});

test("explain_scope — industry omitted returns envelope with industry=null", async () => {
  const mockFetch = async () =>
    jsonResponse({ response: "Scope 1 emissions are direct emissions..." });
  await withMockedFetch(mockFetch, async () => {
    const env = await explainScope({ scope: "1" });
    assert.equal(env.error, null);
    assert.equal(env.result.industry, null);
    assert.ok(env.warnings.find((w) => w.code === "climate_brain_authored"));
  });
});

test("explain_scope — Climate Brain outage returns CLIMATE_BRAIN_UNAVAILABLE error envelope", async () => {
  const mockFetch = async () => jsonResponse({ error: "boom" }, 503);
  await withMockedFetch(mockFetch, async () => {
    const env = await explainScope({ scope: "3", industry: "SaaS" });
    assert.ok(env.error);
    assert.equal(env.error.code, "climate_brain_unavailable");
    assert.equal(env.error.http_status, 503);
    assert.equal(env.result, null);
  });
});

test("explain_scope — invalid scope enum rejected as invalid_input", async () => {
  const env = await explainScope({ scope: "4" });
  assert.equal(env.error.code, "invalid_input");
});

test("explain_scope — missing scope rejected as invalid_input", async () => {
  const env = await explainScope({});
  assert.equal(env.error.code, "invalid_input");
});
