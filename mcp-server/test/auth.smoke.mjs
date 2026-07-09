// Zero-infra smoke tests for the auth/tier-gate layer. Run: `node test/auth.smoke.mjs`.
// No test framework — plain assertions + a runner that exits nonzero on any failure.
// If ai-integrations ever adopts Vitest/Jest, migrate these; the shapes port cleanly.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";

const {
  evaluateToolAccess,
  meetsTierRequirement,
  withTierGate,
  STATUS_FOR_CODE,
  MESSAGE_FOR_CODE
} = await import("../src/middleware/toolTierGate.js");
const {
  buildErrorEnvelope,
  buildSuccessEnvelope
} = await import("../src/responseEnvelope.js");
const {
  buildAnonymousAuth,
  buildAuthenticatedAuth,
  normalizeTier,
  TIERS
} = await import("../src/authContract.js");
const { __setRegistryForTests } = await import("../src/toolRegistry.js");

const results = [];
let currentGroup = "";

const describe = (name, fn) => {
  currentGroup = name;
  fn();
};

const test = (name, fn) => {
  const label = `${currentGroup} › ${name}`;
  try {
    const result = fn();
    if (result instanceof Promise) {
      results.push(
        result.then(
          () => ({ label, ok: true }),
          (err) => ({ label, ok: false, err })
        )
      );
      return;
    }
    results.push(Promise.resolve({ label, ok: true }));
  } catch (err) {
    results.push(Promise.resolve({ label, ok: false, err }));
  }
};

const seedThreeTiers = () =>
  __setRegistryForTests([
    { toolName: "t1_tool", tier: "tier-1" },
    { toolName: "t2_tool", tier: "tier-2" },
    { toolName: "t3_tool", tier: "tier-3" }
  ]);

describe("meetsTierRequirement", () => {
  test("tier-3 meets tier-1", () => {
    assert.equal(meetsTierRequirement("tier-3", "tier-1"), true);
  });
  test("tier-1 does not meet tier-2", () => {
    assert.equal(meetsTierRequirement("tier-1", "tier-2"), false);
  });
  test("unknown tier ranks as 0 (denied against any real tier)", () => {
    assert.equal(meetsTierRequirement("tier-bogus", "tier-1"), false);
  });
});

describe("normalizeTier", () => {
  test("known tier passes through", () => {
    TIERS.forEach((t) => assert.equal(normalizeTier(t), t));
  });
  test("unknown tier collapses to tier-1 with warning", () => {
    assert.equal(normalizeTier("tier-9"), "tier-1");
    assert.equal(normalizeTier(undefined), "tier-1");
  });
});

describe("evaluateToolAccess — decision matrix", () => {
  test("unknown tool → unknown_tool", () => {
    seedThreeTiers();
    const d = evaluateToolAccess("no_such_tool", { tier: "tier-2", keyId: "k" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "unknown_tool");
  });

  test("anonymous on tier-1 tool → allowed", () => {
    seedThreeTiers();
    const d = evaluateToolAccess("t1_tool", { tier: "tier-1", keyId: null });
    assert.equal(d.allowed, true);
  });

  test("anonymous on tier-2 tool → missing_bearer_token (NOT tier_mismatch)", () => {
    seedThreeTiers();
    const d = evaluateToolAccess("t2_tool", { tier: "tier-1", keyId: null });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "missing_bearer_token");
    assert.equal(d.upgradeHint?.cta_url, "https://aclymate.com/ai");
  });

  test("tier-2 key on tier-3 tool → tier_mismatch", () => {
    seedThreeTiers();
    const d = evaluateToolAccess("t3_tool", { tier: "tier-2", keyId: "k-abc" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "tier_mismatch");
  });

  test("tier-3 key on tier-1 tool → allowed (higher tier calls lower)", () => {
    seedThreeTiers();
    const d = evaluateToolAccess("t1_tool", { tier: "tier-3", keyId: "k-xyz" });
    assert.equal(d.allowed, true);
  });

  test("STATUS_FOR_CODE and MESSAGE_FOR_CODE cover every failure code", () => {
    ["unknown_tool", "missing_bearer_token", "tier_mismatch"].forEach(
      (code) => {
        assert.ok(STATUS_FOR_CODE[code], `no status for ${code}`);
        assert.ok(MESSAGE_FOR_CODE[code], `no message for ${code}`);
      }
    );
  });

  test("registry with missing tier field → unknown_tool (fail-CLOSED, not silent tier-1)", () => {
    __setRegistryForTests([{ toolName: "unfielded_tool" }]);
    const d = evaluateToolAccess("unfielded_tool", { tier: "tier-3", keyId: "k" });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "unknown_tool");
  });
});

describe("withTierGate — mandatory getAuth (regression guard)", () => {
  test("throws at registration if getAuth is missing (no silent Tier-1 anonymize)", () => {
    assert.throws(
      () => withTierGate("t1_tool", async () => ({ ok: true }), {}),
      /getAuth.*mandatory/i
    );
  });

  test("throws at registration if options is missing entirely", () => {
    assert.throws(
      () => withTierGate("t1_tool", async () => ({ ok: true })),
      /getAuth.*mandatory/i
    );
  });

  test("with getAuth passing tier-3, invokes handler for a tier-1 tool", async () => {
    __setRegistryForTests([{ toolName: "t1_tool", tier: "tier-1" }]);
    let handled = null;
    const wrapped = withTierGate(
      "t1_tool",
      async (params) => {
        handled = params;
        return { ok: true };
      },
      { getAuth: () => ({ tier: "tier-3", keyId: "k-abc" }) }
    );
    const result = await wrapped({ q: 1 }, {});
    assert.deepEqual(handled, { q: 1 });
    assert.equal(result.ok, true);
  });

  test("with getAuth returning anonymous, blocks a tier-3 tool with missing_bearer_token envelope", async () => {
    __setRegistryForTests([{ toolName: "t3_tool", tier: "tier-3" }]);
    const wrapped = withTierGate(
      "t3_tool",
      async () => ({ shouldNotSee: true }),
      { getAuth: () => ({ tier: "tier-1", keyId: null }) }
    );
    const result = await wrapped({}, {});
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error.code, "missing_bearer_token");
    assert.equal(payload.error.http_status, 401);
    assert.ok(payload.upgrade_hint);
  });
});

describe("buildErrorEnvelope / buildSuccessEnvelope — FM §4 shape", () => {
  test("error envelope has attribution + error + null result + empty warnings/sources", () => {
    const env = buildErrorEnvelope({
      code: "invalid_api_key",
      http_status: 401,
      message: "nope"
    });
    assert.equal(env.attribution.name, "Aclymate");
    assert.equal(env.result, null);
    assert.deepEqual(env.warnings, []);
    assert.deepEqual(env.sources, []);
    assert.equal(env.error.code, "invalid_api_key");
    assert.equal(env.error.http_status, 401);
    assert.equal(env.upgrade_hint, null);
  });

  test("success envelope wraps result + null error + carries confidence", () => {
    const env = buildSuccessEnvelope({
      result: { tons: 1.5 },
      sources: [{ factor_id: "abc" }],
      confidence: "high"
    });
    assert.deepEqual(env.result, { tons: 1.5 });
    assert.equal(env.error, null);
    assert.equal(env.confidence, "high");
    assert.equal(env.attribution.name, "Aclymate");
  });
});

describe("buildAnonymousAuth / buildAuthenticatedAuth (single shape source)", () => {
  test("anonymous auth: tier-1, null identity, computed ipHash", () => {
    const auth = buildAnonymousAuth({
      headers: { "x-forwarded-for": "1.2.3.4" }
    });
    assert.equal(auth.tier, "tier-1");
    assert.equal(auth.accountId, null);
    assert.equal(auth.keyId, null);
    assert.equal(auth.testMode, false);
    assert.equal(auth.rateLimit, null);
    assert.equal(auth.pendingScoutAuth, false);
    assert.match(auth.ipHash, /^[0-9a-f]{64}$/);
  });

  test("authenticated auth: propagates resolved fields", () => {
    const auth = buildAuthenticatedAuth(
      { headers: { "x-forwarded-for": "5.6.7.8" } },
      {
        tier: "tier-2",
        accountId: "co-1",
        keyId: "k-1",
        testMode: true,
        rateLimit: 200
      }
    );
    assert.equal(auth.tier, "tier-2");
    assert.equal(auth.accountId, "co-1");
    assert.equal(auth.keyId, "k-1");
    assert.equal(auth.testMode, true);
    assert.equal(auth.rateLimit, 200);
    assert.match(auth.ipHash, /^[0-9a-f]{64}$/);
  });

  test("authenticated auth: unknown tier from resolver normalizes to tier-1 (drift guard)", () => {
    const auth = buildAuthenticatedAuth(
      { headers: {} },
      { tier: "tier-9", accountId: "co-1", keyId: "k-1" }
    );
    assert.equal(auth.tier, "tier-1");
  });
});

// --- runner ---
const settled = await Promise.all(results);
const failed = settled.filter((r) => !r.ok);
settled.forEach((r) => {
  const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${icon} ${r.label}`);
  if (!r.ok) {
    console.log(`    ${r.err?.stack || r.err}`);
  }
});
console.log(
  `\n${settled.length - failed.length}/${settled.length} passed${failed.length ? `, ${failed.length} FAILED` : ""}`
);
process.exit(failed.length ? 1 : 0);
