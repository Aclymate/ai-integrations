// Zero-infra smoke tests for the categorize_transaction Tier-3 tool.
// Run: `node test/categorizeTransaction.smoke.mjs`. Plain node:assert/strict;
// mirrors rateLimit.smoke.mjs's stubFetch approach since the handler calls
// internalApi.enrichPlaidTransactions directly.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";
process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";

const {
  definition,
  inputShape,
  handler,
  MAX_ENRICH_BATCH
} = await import("../src/tools/tier3/categorizeTransaction.js");

const pending = [];
let currentGroup = "";

const describe = (name, fn) => {
  currentGroup = name;
  fn();
};

const test = (name, fn) => {
  pending.push({ label: `${currentGroup} › ${name}`, fn });
};

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

const buildTransaction = (overrides = {}) => ({
  description: "Whole Foods",
  amount: 42.5,
  date: "2026-07-01",
  currencyCode: "USD",
  ...overrides
});

describe("definition + inputShape", () => {
  test("definition.name is categorize_transaction", () => {
    assert.equal(definition.name, "categorize_transaction");
  });
  test("MAX_ENRICH_BATCH is 100 (Plaid's documented per-request max)", () => {
    assert.equal(MAX_ENRICH_BATCH, 100);
  });
  test("inputShape exposes transactions and accountType", () => {
    assert.ok(inputShape.transactions);
    assert.ok(inputShape.accountType);
  });
});

describe("handler — validation", () => {
  test("empty transactions array: invalid_input, no fetch call", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const env = await handler({ transactions: [] });
      assert.equal(env.error.code, "invalid_input");
      assert.equal(env.error.http_status, 400);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("batch over MAX_ENRICH_BATCH: invalid_input, no fetch call", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const transactions = Array(MAX_ENRICH_BATCH + 1)
        .fill()
        .map(() => buildTransaction());
      const env = await handler({ transactions });
      assert.equal(env.error.code, "invalid_input");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("missing description: invalid_input", async () => {
    const env = await handler({ transactions: [buildTransaction({ description: "" })] });
    assert.equal(env.error.code, "invalid_input");
  });

  test("accountType defaults to credit when omitted", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ enrichedTransactions: [] })
      };
    });
    try {
      await handler({ transactions: [buildTransaction()] });
      assert.equal(sentBody.accountType, "credit");
    } finally {
      restore();
    }
  });
});

describe("handler — success mapping", () => {
  test("maps enriched rows, omitting plaidRawTransactionData/plaidRequestId", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enrichedTransactions: [
            {
              plaidRequestId: "req-123",
              plaidRawTransactionData: { some: "raw-plaid-blob" },
              description: "Whole Foods",
              amount: 42.5,
              direction: "OUTFLOW",
              currencyCode: "USD",
              flowType: "expense",
              location: { city: "Austin" },
              personal_finance_category: { primary: "FOOD_AND_DRINK" },
              vendor: { name: "Whole Foods Market", confidence_level: "HIGH" }
            }
          ]
        })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error, null);
      assert.equal(env.result.transactions.length, 1);
      const tx = env.result.transactions[0];
      assert.equal(tx.description, "Whole Foods");
      assert.equal(tx.vendor.name, "Whole Foods Market");
      assert.equal(tx.flowType, "expense");
      assert.deepEqual(tx.location, { city: "Austin" });
      assert.deepEqual(tx.personalFinanceCategory, { primary: "FOOD_AND_DRINK" });
      assert.equal(tx.currencyCode, "USD");
      assert.equal(Object.prototype.hasOwnProperty.call(tx, "plaidRawTransactionData"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(tx, "plaidRequestId"), false);
      assert.equal(env.sources[0].name, "Plaid transactionsEnrich");
      assert.equal(env.confidence, "high");
      assert.equal(env.warnings.length, 0);
    } finally {
      restore();
    }
  });

  // Regression guard: renew-west's non-production Plaid Enrich short-circuit
  // (sandbox rejects non-canned descriptions) returns transactions with no
  // vendor/location/personal_finance_category at all — only flowType. Before
  // this fix the handler reported confidence:"high" with no warnings on this
  // exact shape, which reads as a clean success that quietly found nothing.
  test("all transactions unenriched (no vendor/location/category): low confidence + enrichment_incomplete warning", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enrichedTransactions: [
            {
              description: "UNITED AIRLINES",
              amount: 412.5,
              direction: "OUTFLOW",
              currencyCode: "USD",
              flowType: "expense"
            }
          ]
        })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error, null);
      const tx = env.result.transactions[0];
      assert.equal(tx.vendor, null);
      assert.equal(tx.location, null);
      assert.equal(tx.personalFinanceCategory, null);
      assert.equal(env.confidence, "low");
      const warning = env.warnings.find((w) => w.code === "enrichment_incomplete");
      assert.ok(warning, "expected an enrichment_incomplete warning");
      assert.match(warning.message, /1 of 1/);
    } finally {
      restore();
    }
  });

  test("mixed batch (one enriched, one not): medium confidence + warning names the count", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enrichedTransactions: [
            {
              description: "Whole Foods",
              flowType: "expense",
              location: { city: "Austin" },
              personal_finance_category: { primary: "FOOD_AND_DRINK" },
              vendor: { name: "Whole Foods Market" }
            },
            {
              description: "UNITED AIRLINES",
              flowType: "expense"
            }
          ]
        })
    }));
    try {
      const env = await handler({
        transactions: [buildTransaction(), buildTransaction({ description: "United" })]
      });
      assert.equal(env.confidence, "medium");
      const warning = env.warnings.find((w) => w.code === "enrichment_incomplete");
      assert.ok(warning);
      assert.match(warning.message, /1 of 2/);
    } finally {
      restore();
    }
  });

  test("vendor present but an empty object still counts as unclassified", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enrichedTransactions: [
            { description: "Mystery Charge", flowType: "expense", vendor: {} }
          ]
        })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.confidence, "low");
      assert.ok(env.warnings.find((w) => w.code === "enrichment_incomplete"));
    } finally {
      restore();
    }
  });
});

describe("handler — failure mapping", () => {
  test("internalApi outage: internal_api_unavailable (503)", async () => {
    const restore = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error.code, "internal_api_unavailable");
      assert.equal(env.error.http_status, 503);
    } finally {
      restore();
    }
  });

  test("Plaid enrichment failure (502 from endpoint): plaid_enrichment_failed", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 502,
      text: async () =>
        JSON.stringify({ error: true, code: "plaid_enrichment_failed", message: "Plaid down" })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error.code, "plaid_enrichment_failed");
      assert.equal(env.error.http_status, 502);
    } finally {
      restore();
    }
  });

  test("endpoint validation rejection (batch_too_large, 400): also maps to plaid_enrichment_failed", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: true, code: "batch_too_large", message: "too many" })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error.code, "plaid_enrichment_failed");
    } finally {
      restore();
    }
  });

  test("untagged 5xx (e.g. an unrelated internal-API crash): internal_api_unavailable, NOT mislabeled as a Plaid failure", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: true, message: "unexpected crash" })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error.code, "internal_api_unavailable");
      assert.equal(env.error.http_status, 503);
    } finally {
      restore();
    }
  });

  test("502 without the plaid_enrichment_failed tag: also treated as outage, not assumed to be Plaid", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: true, code: "some_other_error", message: "bad gateway" })
    }));
    try {
      const env = await handler({ transactions: [buildTransaction()] });
      assert.equal(env.error.code, "internal_api_unavailable");
    } finally {
      restore();
    }
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
  `\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ""}`
);
process.exit(failed.length ? 1 : 0);
