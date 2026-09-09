// Zero-infra smoke tests for the IP-metering middleware. Run: `node test/metering.smoke.mjs`.
// Plain node:assert/strict; mirrors rateLimit.smoke.mjs.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";
process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.MCP_INTERNAL_METERING_BYPASS_SECRET = "smoke-test-bypass-secret!";

const {
  enforceMeteringForRest,
  withMetering,
  shouldSkip,
  buildMeteringCountdownHint,
  buildIpDailyCapEnvelope,
  STATUS_FOR_CODE
} = await import("../src/middleware/metering.js");
const { authMiddleware, authMiddlewareForJsonRpc } = await import(
  "../src/middleware/auth.js"
);
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

const seedRegistry = () =>
  __setRegistryForTests([
    {
      toolName: "estimate_emissions",
      tier: "tier-1",
      dailyThreshold: 3,
      dailyCap: 10
    },
    {
      toolName: "audit_a_number",
      tier: "tier-3",
      dailyThreshold: 3,
      dailyCap: 10
    }
  ]);

const buildAuth = (overrides = {}) => ({
  tier: "tier-1",
  accountId: null,
  keyId: null,
  testMode: false,
  rateLimit: null,
  ipHash: "ipHashHex",
  pendingScoutAuth: false,
  meteringBypass: false,
  ...overrides
});

const buildFakeReq = (overrides = {}) => ({
  headers: {},
  auth: buildAuth(),
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

const jsonFetchResponse = (data) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(data)
});

seedRegistry();

describe("shouldSkip", () => {
  test("anonymous (keyId=null) does NOT skip", () => {
    assert.equal(shouldSkip(buildAuth()), false);
  });
  test("authenticated (keyId set) skips", () => {
    assert.equal(shouldSkip(buildAuth({ keyId: "k1" })), true);
  });
  test("Scout placeholder skips", () => {
    assert.equal(shouldSkip(buildAuth({ pendingScoutAuth: true })), true);
  });
  test("test-mode skips", () => {
    assert.equal(shouldSkip(buildAuth({ testMode: true })), true);
  });
  test("meteringBypass skips", () => {
    assert.equal(shouldSkip(buildAuth({ meteringBypass: true })), true);
  });
  test("null auth skips", () => {
    assert.equal(shouldSkip(null), true);
  });
});

describe("buildIpDailyCapEnvelope — per-tool vs global cap discrimination", () => {
  test("per_tool_cap carries a tool-specific message", () => {
    const envelope = buildIpDailyCapEnvelope("per_tool_cap", "estimate_emissions");
    assert.match(envelope.error.message, /estimate_emissions/);
    assert.equal(envelope.error.code, "ip_daily_cap_exceeded");
    assert.equal(envelope.error.http_status, 429);
    assert.equal(envelope.upgrade_hint.trigger, "ip_daily_cap_exceeded");
    assert.equal(envelope.upgrade_hint.calls_remaining_today, 0);
  });
  test("global_cap carries the cross-tool message (no tool name)", () => {
    const envelope = buildIpDailyCapEnvelope("global_cap", "estimate_emissions");
    assert.match(envelope.error.message, /across Aclymate tools/);
    assert.doesNotMatch(envelope.error.message, /estimate_emissions/);
  });
});

describe("buildMeteringCountdownHint", () => {
  test("shape has all required fields", () => {
    const hint = buildMeteringCountdownHint(6, "estimate_emissions");
    assert.equal(hint.trigger, "conversion_nudge");
    assert.equal(hint.calls_remaining_today, 6);
    assert.equal(hint.cta_url, "https://aclymate.com/ai");
    assert.match(hint.message, /estimate_emissions/);
  });
});

describe("enforceMeteringForRest — REST middleware", () => {
  test("meteringBypass skips: proceeds, no fetch call", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return jsonFetchResponse({});
    });
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq({ auth: buildAuth({ meteringBypass: true }) });
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("within threshold (count <= dailyThreshold): proceeds, no req.meter attached", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 2,
        totalCallsToday: 2,
        callsRemainingToday: 8,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.meter, undefined);
    } finally {
      restore();
    }
  });

  test("nudge zone (count > dailyThreshold): proceeds and attaches req.meter.hint", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 6,
        totalCallsToday: 6,
        callsRemainingToday: 4,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.meter.hint.trigger, "conversion_nudge");
      assert.equal(req.meter.hint.calls_remaining_today, 4);
    } finally {
      restore();
    }
  });

  test("blocked (per_tool_cap): writes 429 envelope, proceed=false", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: false,
        reason: "per_tool_cap",
        perToolCount: 10,
        totalCallsToday: 10,
        callsRemainingToday: 0,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, false);
      assert.equal(res._state.status, STATUS_FOR_CODE.ip_daily_cap_exceeded);
      const body = JSON.parse(res._state.body);
      assert.equal(body.error.code, "ip_daily_cap_exceeded");
      assert.match(body.error.message, /estimate_emissions/);
    } finally {
      restore();
    }
  });

  test("global cap: perToolCount=5 totalCallsToday=100 blocked call carries global-cap message", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: false,
        reason: "global_cap",
        perToolCount: 5,
        totalCallsToday: 100,
        callsRemainingToday: 0,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, false);
      const body = JSON.parse(res._state.body);
      assert.match(body.error.message, /across Aclymate tools/);
    } finally {
      restore();
    }
  });

  test("internalApi outage: fail-open — proceeds, no req.meter, emits mcp_ip_meter_internalapi_outage", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway"
    }));
    const stderr = captureStderr();
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.meter, undefined);
      const events = parseEmittedEvents(stderr.captured);
      assert.ok(
        events.find((e) => e.event === "mcp_ip_meter_internalapi_outage")
      );
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("empty ipHash: still enforces cap (bucket collides), emits mcp_ip_meter_empty_client_ip", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 1,
        totalCallsToday: 1,
        callsRemainingToday: 9,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    const stderr = captureStderr();
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const req = buildFakeReq({ auth: buildAuth({ ipHash: "" }) });
      const res = buildFakeRes();
      const outcome = await mw(req, res);
      assert.equal(outcome.proceed, true);
      const events = parseEmittedEvents(stderr.captured);
      assert.ok(
        events.find((e) => e.event === "mcp_ip_meter_empty_client_ip")
      );
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("missing registry threshold: falls back to {3,10} and emits mcp_ip_meter_missing_threshold", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 1,
        totalCallsToday: 1,
        callsRemainingToday: 9,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      });
    });
    const stderr = captureStderr();
    try {
      const mw = enforceMeteringForRest("totally_unregistered_tool");
      const req = buildFakeReq();
      const res = buildFakeRes();
      await mw(req, res);
      assert.equal(sentBody.dailyThreshold, 3);
      assert.equal(sentBody.dailyCap, 10);
      const events = parseEmittedEvents(stderr.captured);
      assert.ok(
        events.find((e) => e.event === "mcp_ip_meter_missing_threshold")
      );
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("per-tool independence: two different tools forward distinct toolName to internalApi", async () => {
    const seenToolNames = [];
    const restore = stubFetch(async (url, options) => {
      seenToolNames.push(JSON.parse(options.body).toolName);
      return jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 1,
        totalCallsToday: 1,
        callsRemainingToday: 9,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      });
    });
    try {
      await enforceMeteringForRest("estimate_emissions")(buildFakeReq(), buildFakeRes());
      await enforceMeteringForRest("audit_a_number")(buildFakeReq(), buildFakeRes());
      assert.deepEqual(seenToolNames, ["estimate_emissions", "audit_a_number"]);
    } finally {
      restore();
    }
  });
});

describe("Metering runs BEFORE tier-gate", () => {
  test("anonymous Tier-3 tool call increments the IP counter even though tier-gate will later 401", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 1,
        totalCallsToday: 1,
        callsRemainingToday: 9,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      });
    });
    try {
      const { enforceToolTierForRest } = await import(
        "../src/middleware/toolTierGate.js"
      );
      const meterMw = enforceMeteringForRest("audit_a_number");
      const tierMw = enforceToolTierForRest("audit_a_number");
      const req = buildFakeReq();
      const res = buildFakeRes();
      const meterOutcome = await meterMw(req, res);
      assert.equal(meterOutcome.proceed, true);
      assert.equal(fetchCalled, true);
      const tierOutcome = tierMw(req, res);
      assert.equal(tierOutcome.proceed, false);
      assert.equal(res._state.status, 401);
    } finally {
      restore();
    }
  });

  test("MCP path: nudge-zone anonymous caller on a Tier-3 tool keeps tier-gate's tier_403 hint (metering does NOT clobber it)", async () => {
    // withMetering wraps withTierGate (outermost) exactly as buildServer.js
    // composes them. An anonymous caller in the metering nudge zone probing a
    // Tier-3 tool: tier-gate (inner) denies with a tier_403 hint; metering
    // (outer) then tries to inject its conversion_nudge — the existing-hint
    // guard in applySuccessHintToEnvelope must preserve tier_403.
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 5,
        totalCallsToday: 5,
        callsRemainingToday: 5,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const { withTierGate } = await import("../src/middleware/toolTierGate.js");
      const getAuth = () => buildAuth();
      let realHandlerCalled = false;
      const wrapped = withMetering(
        "audit_a_number",
        withTierGate(
          "audit_a_number",
          async () => {
            realHandlerCalled = true;
            return { content: [{ type: "text", text: "should-not-run" }] };
          },
          { getAuth }
        ),
        { getAuth }
      );
      const result = await wrapped({}, {});
      assert.equal(realHandlerCalled, false);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.error.code, "missing_bearer_token");
      assert.equal(payload.upgrade_hint.trigger, "tier_403");
    } finally {
      restore();
    }
  });
});

describe("withMetering — MCP handler wrapping", () => {
  test("meteringBypass: invokes handler untouched (no fetch call)", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return jsonFetchResponse({});
    });
    try {
      const wrapped = withMetering(
        "estimate_emissions",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ meteringBypass: true }) }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("nudge zone: injects upgrade_hint into envelope-shaped MCP response", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: true,
        reason: null,
        perToolCount: 5,
        totalCallsToday: 5,
        callsRemainingToday: 5,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const { buildSuccessEnvelope } = await import("../src/responseEnvelope.js");
      const wrapped = withMetering(
        "estimate_emissions",
        async () => {
          const envelope = buildSuccessEnvelope({ result: { tons: 1.2 } });
          return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.upgrade_hint.trigger, "conversion_nudge");
      assert.equal(payload.upgrade_hint.calls_remaining_today, 5);
    } finally {
      restore();
    }
  });

  test("blocked: returns 429 envelope, does NOT invoke handler", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        allowed: false,
        reason: "per_tool_cap",
        perToolCount: 10,
        totalCallsToday: 10,
        callsRemainingToday: 0,
        resetAtIso: "2026-07-11T00:00:00.000Z"
      })
    );
    try {
      const wrapped = withMetering(
        "estimate_emissions",
        async () => {
          handlerCalled = true;
          return { content: [{ type: "text", text: "should-not-run" }] };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, false);
      assert.equal(result.isError, true);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.error.code, "ip_daily_cap_exceeded");
    } finally {
      restore();
    }
  });

  test("internalApi outage: fail-open — invokes handler untouched", async () => {
    let handlerCalled = false;
    const restore = stubFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error"
    }));
    try {
      const wrapped = withMetering(
        "estimate_emissions",
        async () => {
          handlerCalled = true;
          return { content: [{ type: "text", text: "ok" }] };
        },
        { getAuth: () => buildAuth() }
      );
      const result = await wrapped({}, {});
      assert.equal(handlerCalled, true);
      assert.equal(result.content[0].text, "ok");
    } finally {
      restore();
    }
  });

  test("throws when { getAuth } omitted (regression guard)", () => {
    assert.throws(
      () => withMetering("estimate_emissions", async () => ({})),
      /getAuth.*mandatory/i
    );
  });
});

describe("Bypass header (auth.js) — meteringBypass wiring", () => {
  test("valid secret header: req.auth.meteringBypass === true, zero calls to internalApi", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return jsonFetchResponse({});
    });
    try {
      const req = {
        headers: {
          "x-aclymate-metering-bypass": "smoke-test-bypass-secret!"
        }
      };
      const res = buildFakeRes();
      const outcome = await authMiddleware(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.auth.meteringBypass, true);

      const meterMw = enforceMeteringForRest("estimate_emissions");
      const meterOutcome = await meterMw(req, buildFakeRes());
      assert.equal(meterOutcome.proceed, true);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("invalid secret header: metered normally, stderr contains mcp_ip_meter_bypass_header_invalid", async () => {
    const stderr = captureStderr();
    try {
      const req = {
        headers: { "x-aclymate-metering-bypass": "wrong-secret-value" }
      };
      const res = buildFakeRes();
      const outcome = await authMiddleware(req, res);
      assert.equal(outcome.proceed, true);
      assert.equal(req.auth.meteringBypass, false);
      const events = parseEmittedEvents(stderr.captured);
      assert.ok(
        events.find((e) => e.event === "mcp_ip_meter_bypass_header_invalid")
      );
    } finally {
      stderr.restore();
    }
  });

  test("no header: silent, meteringBypass false", async () => {
    const stderr = captureStderr();
    try {
      const req = { headers: {} };
      const res = buildFakeRes();
      await authMiddleware(req, res);
      assert.equal(req.auth.meteringBypass, false);
      assert.equal(stderr.captured.length, 0);
    } finally {
      stderr.restore();
    }
  });

  test("empty-secret guard: unset secret disables bypass unconditionally, even for an empty-string header", async () => {
    const original = process.env.MCP_INTERNAL_METERING_BYPASS_SECRET;
    delete process.env.MCP_INTERNAL_METERING_BYPASS_SECRET;
    try {
      const req = {
        headers: { "x-aclymate-metering-bypass": "" }
      };
      const res = buildFakeRes();
      await authMiddleware(req, res);
      assert.equal(req.auth.meteringBypass, false);
    } finally {
      process.env.MCP_INTERNAL_METERING_BYPASS_SECRET = original;
    }
  });

  test("constant-time comparison path handles mismatched-length secrets without throwing", async () => {
    const req = {
      headers: { "x-aclymate-metering-bypass": "short" }
    };
    const res = buildFakeRes();
    await assert.doesNotReject(() => authMiddleware(req, res));
    assert.equal(req.auth.meteringBypass, false);
  });
});

describe("Malformed Authorization header (auth.js) — distinct from no header", () => {
  test("typo'd scheme (Bearr <key>): 401 malformed_auth_header, NOT missing_bearer_token", async () => {
    const req = { headers: { authorization: "Bearr acy_live_tier3_abc" } };
    const res = buildFakeRes();
    const outcome = await authMiddleware(req, res);

    assert.equal(outcome.proceed, false);
    assert.equal(res._state.status, 401);
    const body = JSON.parse(res._state.body);
    assert.equal(body.error.code, "malformed_auth_header");
    assert.notEqual(body.error.code, "missing_bearer_token");
    assert.equal(req.auth, undefined, "req.auth must not be set on rejection");
  });

  test("no Authorization header at all: still anonymous (regression guard — must stay distinct from the malformed case above)", async () => {
    const req = { headers: {} };
    const res = buildFakeRes();
    const outcome = await authMiddleware(req, res);

    assert.equal(outcome.proceed, true);
    assert.equal(req.auth.tier, "tier-1");
    assert.equal(res._state.status, null, "no response should be written");
  });

  test("well-formed Bearer header still authenticates normally (regression guard)", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        accountId: "company-1",
        tier: "tier-3",
        keyId: "key-1",
        testMode: false,
        rateLimit: 5000
      })
    );
    try {
      const req = { headers: { authorization: "Bearer acy_live_tier3_abc" } };
      const res = buildFakeRes();
      const outcome = await authMiddleware(req, res);

      assert.equal(outcome.proceed, true);
      assert.equal(req.auth.tier, "tier-3");
      assert.equal(res._state.status, null);
    } finally {
      restore();
    }
  });

  test("scout header still wins over a malformed Authorization header (regression guard)", async () => {
    const req = {
      headers: {
        "x-aclymate-scout-auth": "1",
        authorization: "Bearr acy_live_tier3_abc"
      }
    };
    const res = buildFakeRes();
    const outcome = await authMiddleware(req, res);

    assert.equal(outcome.proceed, true);
    assert.equal(req.auth.pendingScoutAuth, true);
    assert.equal(res._state.status, null);
  });

  test("empty Authorization header value: treated as no header, not malformed", async () => {
    const req = { headers: { authorization: "" } };
    const res = buildFakeRes();
    const outcome = await authMiddleware(req, res);

    assert.equal(outcome.proceed, true);
    assert.equal(req.auth.tier, "tier-1");
  });
});

describe("authMiddlewareForJsonRpc (auth.js) — /mcp auth failures as JSON-RPC, not raw HTTP", () => {
  // StreamableHTTPClientTransport only special-cases HTTP 401 when the client has an
  // OAuth authProvider wired up (irrelevant to our static bearer scheme) — otherwise a
  // non-2xx to /mcp just throws client-side, and most MCP client UIs (Claude Desktop via
  // mcp-remote) surface that as a bare "Server disconnected" with no readable reason.
  // Regression guard: an auth failure on /mcp must come back as HTTP 200 with a
  // JSON-RPC-shaped error, the same shape the client already knows how to parse and
  // reject cleanly — not Aclymate's own REST envelope, and not a non-2xx status.
  test("malformed scheme: HTTP 200, JSON-RPC error shape, not the REST envelope", async () => {
    const req = { headers: { authorization: "Bearr acy_live_tier3_abc" } };
    const res = buildFakeRes();
    const outcome = await authMiddlewareForJsonRpc(req, res);

    assert.equal(outcome.proceed, false);
    assert.equal(res._state.status, 200);
    const body = JSON.parse(res._state.body);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, null);
    assert.equal(typeof body.error.code, "number");
    assert.match(body.error.message, /Bearer/);
    assert.equal(body.error.data.aclymate_code, "malformed_auth_header");
    assert.equal(Object.prototype.hasOwnProperty.call(body, "attribution"), false);
  });

  test("well-formed but nonexistent key: still HTTP 200 with a JSON-RPC error, not 401", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: true })
    }));
    try {
      const req = { headers: { authorization: "Bearer acy_live_tier3_doesnotexist" } };
      const res = buildFakeRes();
      const outcome = await authMiddlewareForJsonRpc(req, res);

      assert.equal(outcome.proceed, false);
      assert.equal(res._state.status, 200);
      const body = JSON.parse(res._state.body);
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.data.aclymate_code, "invalid_api_key");
    } finally {
      restore();
    }
  });

  test("valid key still authenticates normally through the jsonrpc-wrapped middleware", async () => {
    const restore = stubFetch(async () =>
      jsonFetchResponse({
        accountId: "company-1",
        tier: "tier-3",
        keyId: "key-1",
        testMode: false,
        rateLimit: 5000
      })
    );
    try {
      const req = { headers: { authorization: "Bearer acy_live_tier3_real" } };
      const res = buildFakeRes();
      const outcome = await authMiddlewareForJsonRpc(req, res);

      assert.equal(outcome.proceed, true);
      assert.equal(req.auth.tier, "tier-3");
      assert.equal(res._state.status, null);
    } finally {
      restore();
    }
  });

  test("the default authMiddleware (REST routes) is unaffected — still the Aclymate envelope at its real status", async () => {
    const req = { headers: { authorization: "Bearr acy_live_tier3_abc" } };
    const res = buildFakeRes();
    const outcome = await authMiddleware(req, res);

    assert.equal(outcome.proceed, false);
    assert.equal(res._state.status, 401);
    const body = JSON.parse(res._state.body);
    assert.equal(body.error.code, "malformed_auth_header");
    assert.equal(body.jsonrpc, undefined);
  });
});

describe("Concurrency", () => {
  test("50 parallel requests: no thrown exceptions, sum(200s)+sum(429s)===50, internalApi called exactly 50 times", async () => {
    let callCount = 0;
    const restore = stubFetch(async () => {
      callCount += 1;
      const count = callCount;
      return jsonFetchResponse({
        allowed: count <= 10,
        reason: count <= 10 ? null : "per_tool_cap",
        perToolCount: Math.min(count, 10),
        totalCallsToday: Math.min(count, 10),
        callsRemainingToday: Math.max(0, 10 - count),
        resetAtIso: "2026-07-11T00:00:00.000Z"
      });
    });
    try {
      const mw = enforceMeteringForRest("estimate_emissions");
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const req = buildFakeReq();
          const res = buildFakeRes();
          await mw(req, res);
          return res._state.status ?? 200;
        })
      );
      const okCount = outcomes.filter((s) => s === 200).length;
      const blockedCount = outcomes.filter(
        (s) => s === STATUS_FOR_CODE.ip_daily_cap_exceeded
      ).length;
      assert.equal(okCount + blockedCount, 50);
      assert.equal(callCount, 50);
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
