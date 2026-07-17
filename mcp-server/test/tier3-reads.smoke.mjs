// Zero-infra smoke tests for the Tier-3 read tools. Run: `node test/tier3-reads.smoke.mjs`.
// Stubs globalThis.fetch (the tools hit the localhost internalApi path, which uses
// fetch) so no live renew-west is needed. Mirrors audit.smoke.mjs.

import assert from "node:assert/strict";

process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";

const { handler: getEmissionsSummary } = await import(
  "../src/tools/tier3/reads/getEmissionsSummary.js"
);
const { handler: listEmissionSources } = await import(
  "../src/tools/tier3/reads/listEmissionSources.js"
);
const { handler: getVendorBreakdown } = await import(
  "../src/tools/tier3/reads/getVendorBreakdown.js"
);
const { handler: auditANumber } = await import(
  "../src/tools/tier3/reads/auditANumber.js"
);
const { handler: generateDisclosureResponse } = await import(
  "../src/tools/tier3/reads/generateDisclosureResponse.js"
);
const { handler: calculateProductCarbonFootprint } = await import(
  "../src/tools/tier3/reads/calculateProductCarbonFootprint.js"
);
const { withTierGate } = await import("../src/middleware/toolTierGate.js");
const { __setRegistryForTests } = await import("../src/toolRegistry.js");

const pending = [];
let currentGroup = "";

const describe = (name, fn) => {
  currentGroup = name;
  fn();
};

const test = (name, fn) => {
  pending.push({ label: `${currentGroup} › ${name}`, fn });
};

const buildAuth = (overrides = {}) => ({
  tier: "tier-3",
  accountId: "co-1",
  keyId: "key-1",
  testMode: false,
  rateLimit: 5000,
  pendingScoutAuth: false,
  ...overrides
});

const stubFetch = (status, body) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  });
  return () => {
    globalThis.fetch = original;
  };
};

const withFetch = async (status, body, run) => {
  const restore = stubFetch(status, body);
  try {
    return await run();
  } finally {
    restore();
  }
};

describe("get_emissions_summary", () => {
  test("happy path returns the summary in a success envelope", async () => {
    const env = await withFetch(
      200,
      {
        totalTonsCo2e: 142.5,
        byScope: { 1: 38, 2: 20, 3: 84.5 },
        byCategory: [{ category: "spend-based", scope: 3, tonsCo2e: 84.5 }],
        warnings: []
      },
      () => getEmissionsSummary({}, { auth: buildAuth() })
    );
    assert.equal(env.error, null);
    assert.equal(env.result.totalTonsCo2e, 142.5);
    assert.equal(env.attribution.name, "Aclymate");
  });

  test("empty-data window surfaces a no_data_in_range warning (not an error)", async () => {
    const env = await withFetch(
      200,
      {
        totalTonsCo2e: 0,
        byScope: { 1: 0, 2: 0, 3: 0 },
        byCategory: [],
        warnings: [{ code: "no_data_in_range", message: "none" }]
      },
      () => getEmissionsSummary({ startDate: "2019-01-01" }, { auth: buildAuth() })
    );
    assert.equal(env.error, null);
    assert.equal(env.warnings[0].code, "no_data_in_range");
  });

  test("outage maps to an internal_api_unavailable error envelope", async () => {
    const env = await withFetch(503, {}, () =>
      getEmissionsSummary({}, { auth: buildAuth() })
    );
    assert.ok(env.error);
    assert.equal(env.error.code, "internal_api_unavailable");
  });
});

describe("list_emission_sources", () => {
  test("happy path returns ranked sources", async () => {
    const env = await withFetch(
      200,
      {
        sources: [{ name: "spend-based", tonsCo2e: 84.5 }],
        groupBy: "category",
        warnings: []
      },
      () => listEmissionSources({ groupBy: "category" }, { auth: buildAuth() })
    );
    assert.equal(env.error, null);
    assert.equal(env.result.sources[0].name, "spend-based");
  });
});

describe("get_vendor_breakdown", () => {
  test("happy path returns vendors", async () => {
    const env = await withFetch(
      200,
      {
        vendors: [{ id: "vr-1", name: "Acme", tonsCo2e: 12 }],
        warnings: []
      },
      () => getVendorBreakdown({}, { auth: buildAuth() })
    );
    assert.equal(env.error, null);
    assert.equal(env.result.vendors[0].name, "Acme");
  });
});

describe("audit_a_number", () => {
  test("happy path returns transaction + lineage", async () => {
    const env = await withFetch(
      200,
      {
        transaction: { tonsCo2e: 1.2, subcategory: "spend-based" },
        lineage: { method: "spend-based", methodologyUrl: null },
        warnings: [{ code: "methodology_pending", message: "pending" }]
      },
      () => auditANumber({ transactionId: "tx-1" }, { auth: buildAuth() })
    );
    assert.equal(env.error, null);
    assert.equal(env.result.transaction.tonsCo2e, 1.2);
  });

  test("a transaction owned by another company maps to not_found", async () => {
    const env = await withFetch(
      404,
      { error: true, code: "not_found", message: "No transaction found." },
      () => auditANumber({ transactionId: "tx-other" }, { auth: buildAuth() })
    );
    assert.ok(env.error);
    assert.equal(env.error.code, "not_found");
  });

  test("missing transactionId is rejected before any request (invalid_input)", async () => {
    const env = await auditANumber({}, { auth: buildAuth() });
    assert.ok(env.error);
    assert.equal(env.error.code, "invalid_input");
  });
});

describe("generate_disclosure_response", () => {
  test("happy path returns a grounded draft", async () => {
    const env = await withFetch(
      200,
      {
        draft: "In the reporting period the company recorded 142.5 tCO2e.",
        grounding: { totalTonsCo2e: 142.5, framework: "cdp" },
        warnings: []
      },
      () =>
        generateDisclosureResponse(
          { question: "What were our Scope 3 emissions?", framework: "cdp" },
          { auth: buildAuth() }
        )
    );
    assert.equal(env.error, null);
    assert.match(env.result.draft, /142\.5/);
  });

  test("off-scope question returns a declining draft (success, not error)", async () => {
    const env = await withFetch(
      200,
      {
        draft:
          "That question is outside the scope of the carbon-emissions data Aclymate tracks.",
        grounding: { totalTonsCo2e: 142.5, framework: "other" },
        warnings: []
      },
      () =>
        generateDisclosureResponse(
          { question: "What is the capital of France?" },
          { auth: buildAuth() }
        )
    );
    assert.equal(env.error, null);
    assert.ok(env.result.draft.length > 0);
  });

  test("empty/too-short question is rejected before the model (invalid_input)", async () => {
    const env = await generateDisclosureResponse(
      { question: "hi" },
      { auth: buildAuth() }
    );
    assert.ok(env.error);
    assert.equal(env.error.code, "invalid_input");
  });
});

describe("calculate_product_carbon_footprint", () => {
  test("happy path returns a footprint in kgCO2e", async () => {
    const env = await withFetch(
      200,
      {
        name: "Widget",
        totalKgsCo2e: 3.21,
        footprintBreakdownKgs: { materials: 2, packaging: 1.21 },
        units: "kgCO2e",
        warnings: []
      },
      () =>
        calculateProductCarbonFootprint(
          { product_id: "prod-1" },
          { auth: buildAuth() }
        )
    );
    assert.equal(env.error, null);
    assert.equal(env.result.units, "kgCO2e");
    assert.equal(env.result.totalKgsCo2e, 3.21);
  });

  test("a product owned by another company maps to not_found", async () => {
    const env = await withFetch(
      404,
      { error: true, code: "not_found", message: "No product found." },
      () =>
        calculateProductCarbonFootprint(
          { product_id: "prod-other" },
          { auth: buildAuth() }
        )
    );
    assert.ok(env.error);
    assert.equal(env.error.code, "not_found");
  });

  test("a company without the PCF subscription maps to 403 pcf_subscription_required with an upgrade hint", async () => {
    const env = await withFetch(
      403,
      {
        error: true,
        code: "pcf_subscription_required",
        message: "No PCF subscription.",
        upgrade_hint: { cta_url: null, message: "Contact Aclymate." }
      },
      () =>
        calculateProductCarbonFootprint(
          { product_id: "prod-1" },
          { auth: buildAuth() }
        )
    );
    assert.ok(env.error);
    assert.equal(env.error.code, "pcf_subscription_required");
    assert.ok(env.upgrade_hint);
  });
});

describe("tier gate", () => {
  test("a Tier-2 key calling a Tier-3 read tool is rejected", async () => {
    __setRegistryForTests([
      { toolName: "get_emissions_summary", tier: "tier-3" }
    ]);
    const gated = withTierGate(
      "get_emissions_summary",
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { getAuth: () => buildAuth({ tier: "tier-2" }) }
    );
    const response = await gated({});
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /tier_mismatch/);
  });
});

const results = [];
for (const { label, fn } of pending) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, err });
  }
}
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${icon} ${r.label}`);
  if (!r.ok) {
    console.log(`    ${r.err?.stack || r.err}`);
  }
});
console.log(
  `\n${results.length - failed.length}/${results.length} passed${
    failed.length ? `, ${failed.length} FAILED` : ""
  }`
);
process.exit(failed.length ? 1 : 0);
