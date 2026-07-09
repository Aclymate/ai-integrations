// Zero-infra smoke tests for the rate-limit middleware. Run: `node test/rateLimit.smoke.mjs`.
// Plain node:assert/strict; mirrors auth.smoke.mjs.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";
process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";

const {
  enforceRateLimitForRest,
  withRateLimit,
  shouldSkip,
  applySuccessHintToEnvelope,
  buildSuccessCountdownHint,
  STATUS_FOR_CODE
} = await import("../src/middleware/rateLimit.js");
const { buildSuccessEnvelope } = await import("../src/responseEnvelope.js");

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
  tier: "tier-2",
  accountId: "co-1",
  keyId: "key-1",
  testMode: false,
  rateLimit: 200,
  ipHash: "ipHashHex",
  pendingScoutAuth: false,
  ...overrides
});

const buildFakeRes = () => {
  const state = { status: null, body: null, headers: null };
  return {
    _state: state,
    writeHead: (status, headers) => {
      state.status = status;
      state.headers = headers;
    },
    end: (payload) => {
      state.body = payload;
    }
  };
};

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

const captureStderr = () => {
  const captured = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return {
    captured,
    restore: () => {
      process.stderr.write = original;
    }
  };
};

const parseEmittedEvents = (captured) =>
  captured
    .map((line) => {
      try {
        return JSON.parse(line.trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);

describe("shouldSkip", () => {
  test("anonymous (keyId=null) skips", () => {
    assert.equal(shouldSkip({ keyId: null }), true);
  });
  test("Scout placeholder skips", () => {
    assert.equal(shouldSkip({ keyId: "k", pendingScoutAuth: true }), true);
  });
  test("test-mode key skips", () => {
    assert.equal(shouldSkip({ keyId: "k", testMode: true }), true);
  });
  test("authenticated live key does NOT skip", () => {
    assert.equal(shouldSkip({ keyId: "k", testMode: false, pendingScoutAuth: false }), false);
  });
  test("null auth skips", () => {
    assert.equal(shouldSkip(null), true);
  });
});

describe("withRateLimit — mandatory getAuth (regression guard)", () => {
  test("throws when options omitted", () => {
    assert.throws(
      () => withRateLimit("tool", async () => ({})),
      /getAuth.*mandatory/i
    );
  });
  test("throws when getAuth omitted", () => {
    assert.throws(
      () => withRateLimit("tool", async () => ({}), {}),
      /getAuth.*mandatory/i
    );
  });
});

describe("applySuccessHintToEnvelope — success-side countdown injection", () => {
  test("injects upgrade_hint on envelope-shaped response with null upgrade_hint", () => {
    const envelope = buildSuccessEnvelope({ result: { tons: 1.2 } });
    const injected = applySuccessHintToEnvelope(envelope, 42);
    assert.equal(injected.upgrade_hint.trigger, "conversion_nudge");
    assert.equal(injected.upgrade_hint.calls_remaining_today, 42);
    assert.equal(injected.upgrade_hint.cta_url, "https://aclymate.com/ai");
  });

  test("does NOT overwrite an existing upgrade_hint (e.g. tier-mismatch hint)", () => {
    const envelope = buildSuccessEnvelope({
      result: { tons: 1.2 },
      upgradeHint: {
        trigger: "tier_403",
        message: "keep-me",
        cta_url: "https://aclymate.com/ai",
        calls_remaining_today: null
      }
    });
    const injected = applySuccessHintToEnvelope(envelope, 42);
    assert.equal(injected.upgrade_hint.trigger, "tier_403");
    assert.equal(injected.upgrade_hint.message, "keep-me");
  });

  test("passes non-envelope objects through unchanged", () => {
    const notEnvelope = { result: { tons: 1 } };
    assert.deepEqual(applySuccessHintToEnvelope(notEnvelope, 5), notEnvelope);
  });

  test("passes null through unchanged", () => {
    assert.equal(applySuccessHintToEnvelope(null, 5), null);
  });

  test("buildSuccessCountdownHint shape has all required fields", () => {
    const hint = buildSuccessCountdownHint(7);
    assert.equal(hint.trigger, "conversion_nudge");
    assert.equal(hint.calls_remaining_today, 7);
    assert.equal(hint.cta_url, "https://aclymate.com/ai");
    assert.ok(hint.message.length > 0);
  });
});

describe("withRateLimit — success-side upgrade_hint injection into MCP envelopeToContent responses", () => {
  test("authenticated + allowed on envelope-shaped tool response: injects upgrade_hint with post-increment count", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 17,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => {
          const envelope = buildSuccessEnvelope({ result: { tons: 1.5 } });
          return {
            content: [{ type: "text", text: JSON.stringify(envelope) }]
          };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.upgrade_hint.trigger, "conversion_nudge");
      assert.equal(payload.upgrade_hint.calls_remaining_today, 17);
      assert.deepEqual(payload.result, { tons: 1.5 });
    } finally {
      restore();
    }
  });

  test("authenticated + allowed on non-envelope tool response (legacy prose tool): passes through unchanged", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 17,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "just prose" }] }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "just prose");
    } finally {
      restore();
    }
  });

  test("multi-block content skips injection AND emits `rate_limit_hint_skip_multi_block` warning", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 5,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    const stderr = captureStderr();
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({
          content: [
            { type: "text", text: "block A" },
            { type: "text", text: "block B" }
          ]
        }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content.length, 2);
      const events = parseEmittedEvents(stderr.captured);
      const skip = events.find(
        (e) => e.event === "rate_limit_hint_skip_multi_block"
      );
      assert.ok(skip, "expected rate_limit_hint_skip_multi_block warning");
      assert.equal(skip.blockCount, 2);
      assert.equal(skip.toolName, "t1");
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("non-JSON text content (legacy prose tool) skips injection AND emits `rate_limit_hint_skip_invalid_json` warning", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 5,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    const stderr = captureStderr();
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "just prose" }] }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "just prose");
      const events = parseEmittedEvents(stderr.captured);
      const skip = events.find(
        (e) => e.event === "rate_limit_hint_skip_invalid_json"
      );
      assert.ok(skip, "expected rate_limit_hint_skip_invalid_json warning");
      assert.equal(skip.toolName, "t1");
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("test-mode key on envelope response: passes through unchanged (no injection, since counter skipped)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({
          content: [
            { type: "text", text: JSON.stringify(buildSuccessEnvelope({ result: { tons: 1 } })) }
          ]
        }),
        { getAuth: () => buildAuth({ testMode: true }) }
      );
      const result = await wrapped({}, {});
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.upgrade_hint, null);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

describe("withRateLimit — MCP handler wrapping", () => {
  test("anonymous auth: invokes handler untouched (no fetch call)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ keyId: null }) }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("test-mode key: invokes handler untouched (no fetch call)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ testMode: true }) }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("Scout placeholder: invokes handler untouched", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ pendingScoutAuth: true }) }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("authenticated live key + allowed: invokes handler", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 199,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(result.isError, undefined);
    } finally {
      restore();
    }
  });

  test("authenticated live key + blocked: returns 429 envelope, does NOT invoke handler, emits keyMasked in warning", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: false,
          callsRemainingToday: 0,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    const stderr = captureStderr();
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => {
          handlerCalled = true;
          return { content: [{ type: "text", text: "should-not-run" }] };
        },
        { getAuth: () => buildAuth({ keyId: "abcdEFGH" }) }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.isError, true);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.error.code, "rate_limit_exceeded");
      assert.equal(payload.error.http_status, 429);
      assert.equal(payload.upgrade_hint.trigger, "rate_limit_429");
      assert.equal(payload.upgrade_hint.cta_url, "https://aclymate.com/ai");
      assert.equal(payload.upgrade_hint.calls_remaining_today, 0);
      const events = parseEmittedEvents(stderr.captured);
      const blocked = events.find(
        (e) => e.event === "rate_limit_blocked_mcp"
      );
      assert.ok(blocked, "expected rate_limit_blocked_mcp warning");
      assert.equal(blocked.keyMasked, "EFGH");
      assert.equal(blocked.toolName, "t1");
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("internalApi outage (5xx): returns 503 envelope", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: true, message: "bad gateway" })
    }));
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => {
          handlerCalled = true;
          return { content: [{ type: "text", text: "unreached" }] };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.isError, true);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.error.code, "internal_api_unavailable");
      assert.equal(payload.error.http_status, 503);
    } finally {
      restore();
    }
  });

  test("internalApi denied (4xx): also returns 503 (fail-closed — treat resolve error as outage, not 429) AND emits bad-invariant warning", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: true, code: "invalid_api_key", message: "gone" })
    }));
    const stderr = captureStderr();
    try {
      const wrapped = withRateLimit(
        "t1",
        async () => ({ content: [{ type: "text", text: "unreached" }] }),
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(result.isError, true);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.error.code, "internal_api_unavailable");
      const events = parseEmittedEvents(stderr.captured);
      const badInvariant = events.find(
        (e) => e.event === "rate_limit_counter_endpoint_bad_invariant"
      );
      assert.ok(
        badInvariant,
        "expected rate_limit_counter_endpoint_bad_invariant warning (not the old 'denied' event name)"
      );
      assert.equal(badInvariant.code, "invalid_api_key");
    } finally {
      stderr.restore();
      restore();
    }
  });
});

describe("enforceRateLimitForRest — REST middleware", () => {
  test("anonymous auth: proceeds (no fetch call)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    });
    try {
      const mw = enforceRateLimitForRest("t1");
      const req = { auth: buildAuth({ keyId: null }) };
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(fetchCalled, false);
      assert.equal(res._state.status, null);
    } finally {
      restore();
    }
  });

  test("authenticated + allowed: proceeds and attaches req.rateLimit meta", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          callsRemainingToday: 42,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const mw = enforceRateLimitForRest("t1");
      const req = { auth: buildAuth() };
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.rateLimit.callsRemainingToday, 42);
      assert.equal(req.rateLimit.dailyLimit, 200);
      assert.equal(req.rateLimit.resetAtIso, "2026-07-10T00:00:00.000Z");
    } finally {
      restore();
    }
  });

  test("authenticated + blocked: writes 429 envelope to res and proceed=false", async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: false,
          callsRemainingToday: 0,
          dailyLimit: 200,
          resetAtIso: "2026-07-10T00:00:00.000Z"
        })
    }));
    try {
      const mw = enforceRateLimitForRest("t1");
      const req = { auth: buildAuth() };
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, false);
      assert.equal(res._state.status, STATUS_FOR_CODE.rate_limit_exceeded);
      const body = JSON.parse(res._state.body);
      assert.equal(body.error.code, "rate_limit_exceeded");
      assert.equal(body.error.http_status, 429);
      assert.equal(body.upgrade_hint.trigger, "rate_limit_429");
    } finally {
      restore();
    }
  });

  test("internalApi outage: writes 503 envelope to res and proceed=false", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error"
    }));
    try {
      const mw = enforceRateLimitForRest("t1");
      const req = { auth: buildAuth() };
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, false);
      assert.equal(res._state.status, STATUS_FOR_CODE.internal_api_unavailable);
      const body = JSON.parse(res._state.body);
      assert.equal(body.error.code, "internal_api_unavailable");
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
