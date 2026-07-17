// Zero-infra smoke tests for the per-tool call-cap middleware.
// Run: `node test/toolCallCap.smoke.mjs`. Plain node:assert/strict; mirrors rateLimit.smoke.mjs.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";
process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";

const {
  withToolCallCap,
  shouldSkip,
  TOOL_DAILY_CALL_CAPS
} = await import("../src/middleware/toolCallCap.js");

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
  ipHash: "ipHashHex",
  pendingScoutAuth: false,
  ...overrides
});

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

describe("TOOL_DAILY_CALL_CAPS", () => {
  test("categorize_transaction is capped at 50", () => {
    assert.equal(TOOL_DAILY_CALL_CAPS.categorize_transaction, 50);
  });
});

describe("shouldSkip", () => {
  test("uncapped tool name skips", () => {
    assert.equal(shouldSkip(buildAuth(), "classify_vendor_by_industry"), true);
  });
  test("capped tool but no keyId skips", () => {
    assert.equal(
      shouldSkip(buildAuth({ keyId: null }), "categorize_transaction"),
      true
    );
  });
  test("null auth skips", () => {
    assert.equal(shouldSkip(null, "categorize_transaction"), true);
  });
  test("capped tool + keyId does NOT skip (including test-mode)", () => {
    assert.equal(
      shouldSkip(buildAuth({ testMode: true }), "categorize_transaction"),
      false
    );
  });
});

describe("withToolCallCap — mandatory getAuth (regression guard)", () => {
  test("throws when options omitted", () => {
    assert.throws(
      () => withToolCallCap("categorize_transaction", async () => ({})),
      /getAuth.*mandatory/i
    );
  });
  test("throws when getAuth omitted", () => {
    assert.throws(
      () => withToolCallCap("categorize_transaction", async () => ({}), {}),
      /getAuth.*mandatory/i
    );
  });
});

describe("withToolCallCap — skip path", () => {
  test("uncapped tool: invokes handler untouched (no fetch call)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const wrapped = withToolCallCap(
        "classify_vendor_by_industry",
        async () => ({ result: { ok: true }, error: null }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.deepEqual(result, { result: { ok: true }, error: null });
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

describe("withToolCallCap — allowed path", () => {
  test("allowed: invokes handler and returns its envelope unchanged", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 49,
          dailyLimit: 50,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const wrapped = withToolCallCap(
        "categorize_transaction",
        async () => {
          handlerCalled = true;
          return { result: { transactions: [] }, error: null };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, true);
      assert.deepEqual(result, { result: { transactions: [] }, error: null });
    } finally {
      restore();
    }
  });

  test("test-mode key: still consults the counter (does NOT skip like C6's rate limit)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            allowed: true,
            callsRemainingToday: 49,
            dailyLimit: 50,
            resetAtIso: "2026-07-10T00:00:00.000Z"
          })
      };
    });
    try {
      const wrapped = withToolCallCap(
        "categorize_transaction",
        async () => ({ result: {}, error: null }),
        { getAuth: () => buildAuth({ testMode: true }) }
      );
      await wrapped({}, {});
      assert.equal(fetchCalled, true, "expected the counter to be consulted for test-mode keys");
    } finally {
      restore();
    }
  });
});

describe("withToolCallCap — blocked path (51st call)", () => {
  test("blocked: does NOT invoke handler, returns tool_daily_cap_reached (429)", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: false,
          callsRemainingToday: 0,
          dailyLimit: 50,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const wrapped = withToolCallCap(
        "categorize_transaction",
        async () => {
          handlerCalled = true;
          return { result: {}, error: null };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.error.code, "tool_daily_cap_reached");
      assert.equal(result.error.http_status, 429);
      assert.equal(result.upgrade_hint.trigger, "tool_daily_cap");
      assert.equal(result.upgrade_hint.cta_url, "https://aclymate.com/ai");
    } finally {
      restore();
    }
  });
});

describe("withToolCallCap — internalApi outage (fail-closed)", () => {
  test("outage (5xx): does NOT invoke handler, returns internal_api_unavailable (503)", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: true, message: "bad gateway" })
    }));
    try {
      const wrapped = withToolCallCap(
        "categorize_transaction",
        async () => {
          handlerCalled = true;
          return { result: {}, error: null };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.error.code, "internal_api_unavailable");
      assert.equal(result.error.http_status, 503);
    } finally {
      restore();
    }
  });

  test("network failure: fails closed the same way", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const wrapped = withToolCallCap(
        "categorize_transaction",
        async () => {
          handlerCalled = true;
          return { result: {}, error: null };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.error.code, "internal_api_unavailable");
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
