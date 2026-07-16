// Zero-infra smoke tests for the audit-log middleware. Run: `node test/audit.smoke.mjs`.
// Plain node:assert/strict; mirrors rateLimit.smoke.mjs / metering.smoke.mjs.

import assert from "node:assert/strict";

process.env.MCP_IP_HASH_SALT = "smoke-test-salt";
process.env.RENEW_WEST_INTERNAL_API_URL =
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  "http://localhost:5001/x/us-central1/internalApi";

const {
  shouldAudit,
  hashResult,
  redactForLogging,
  recordAuditEntry,
  runAudited,
  withAudit
} = await import("../src/middleware/audit.js");

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
  rateLimit: 200,
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

const fetchSuccess = (entryId = "entry-1") =>
  async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ entryId })
  });

describe("shouldAudit", () => {
  test("tier-1 auth is not audited", () => {
    assert.equal(shouldAudit(buildAuth({ tier: "tier-1" })), false);
  });
  test("tier-2 auth is not audited", () => {
    assert.equal(shouldAudit(buildAuth({ tier: "tier-2" })), false);
  });
  test("test-mode tier-3 key is not audited", () => {
    assert.equal(shouldAudit(buildAuth({ testMode: true })), false);
  });
  test("missing accountId is not audited", () => {
    assert.equal(shouldAudit(buildAuth({ accountId: null })), false);
  });
  test("missing keyId is not audited", () => {
    assert.equal(shouldAudit(buildAuth({ keyId: null })), false);
  });
  test("null auth is not audited", () => {
    assert.equal(shouldAudit(null), false);
  });
  test("live tier-3 auth IS audited", () => {
    assert.equal(shouldAudit(buildAuth()), true);
  });
});

describe("hashResult", () => {
  test("stable hex digest for a fixed input", () => {
    const a = hashResult({ result: { tons: 1.5 } });
    const b = hashResult({ result: { tons: 1.5 } });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
  test("different inputs hash differently", () => {
    assert.notEqual(
      hashResult({ result: { tons: 1.5 } }),
      hashResult({ result: { tons: 2.5 } })
    );
  });
  test("does not throw on a circular structure", () => {
    const circular = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => hashResult(circular));
    assert.match(hashResult(circular), /^[0-9a-f]{64}$/);
  });
});

describe("redactForLogging", () => {
  test("flat object reduces every leaf to a type token", () => {
    const redacted = redactForLogging({
      vendorName: "Acme Corp",
      amount: 4200.5,
      isRefund: false
    });
    assert.equal(redacted.vendorName, "<string:9>");
    assert.equal(redacted.amount, "<number>");
    assert.equal(redacted.isRefund, "<boolean>");
    assert.ok(!JSON.stringify(redacted).includes("Acme Corp"));
  });

  test("nested object recurses, keys preserved, values redacted", () => {
    const redacted = redactForLogging({
      vendor: { name: "Acme Corp", employeeCount: 42 }
    });
    assert.equal(redacted.vendor.name, "<string:9>");
    assert.equal(redacted.vendor.employeeCount, "<number>");
    assert.ok(!JSON.stringify(redacted).includes("Acme Corp"));
    assert.ok(!JSON.stringify(redacted).includes("42"));
  });

  test("array of objects redacts every element", () => {
    const redacted = redactForLogging([
      { vendorName: "Acme Corp" },
      { vendorName: "Globex" }
    ]);
    assert.equal(redacted[0].vendorName, "<string:9>");
    assert.equal(redacted[1].vendorName, "<string:6>");
  });

  test("a PII value never survives redaction, regardless of nesting depth", () => {
    const pii = { vendorName: "Acme Corp", amount: 4200.5, employeeCount: 42 };
    const nested = { level1: { level2: { level3: pii } } };
    const serialized = JSON.stringify(redactForLogging(nested));
    assert.ok(!serialized.includes("Acme Corp"));
    assert.ok(!serialized.includes("4200.5"));
    assert.ok(!serialized.includes("42"));
  });

  test("null passes through as a type token, not a crash", () => {
    assert.equal(redactForLogging(null), "<null>");
  });
});

describe("recordAuditEntry — transport-agnostic core", () => {
  test("shouldAudit=false short-circuits: no fetch call", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return fetchSuccess()();
    });
    try {
      await recordAuditEntry({
        auth: buildAuth({ tier: "tier-1" }),
        sourceAgent: "claude",
        toolName: "get_emissions_summary",
        inputs: { vendorName: "Acme Corp" },
        response: { result: { tons: 1 } },
        latencyMs: 12
      });
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("live tier-3: sends the REAL (unredacted) inputs to internalApi", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess("entry-42")();
    });
    try {
      await recordAuditEntry({
        auth: buildAuth(),
        sourceAgent: "claude",
        toolName: "get_emissions_summary",
        inputs: { vendorName: "Acme Corp", amount: 4200.5 },
        response: { result: { tons: 1 } },
        latencyMs: 12
      });
      assert.ok(sentBody, "expected a request body to have been sent");
      assert.equal(sentBody.companyId, "co-1");
      assert.equal(sentBody.keyId, "key-1");
      assert.equal(sentBody.tool, "get_emissions_summary");
      assert.equal(sentBody.sourceAgent, "claude");
      assert.equal(sentBody.latencyMs, 12);
      assert.deepEqual(sentBody.inputs, {
        vendorName: "Acme Corp",
        amount: 4200.5
      });
      assert.match(sentBody.resultHash, /^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  test("internalApi outage: does not throw, emits mcp_audit_record_failed with redacted inputs only", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 503,
      text: async () => "unavailable"
    }));
    const stderr = captureStderr();
    try {
      await recordAuditEntry({
        auth: buildAuth(),
        sourceAgent: "claude",
        toolName: "get_emissions_summary",
        inputs: { vendorName: "Acme Corp" },
        response: { result: { tons: 1 } },
        latencyMs: 12
      });
      const events = parseEmittedEvents(stderr.captured);
      const failure = events.find((e) => e.event === "mcp_audit_record_failed");
      assert.ok(failure, "expected mcp_audit_record_failed warning");
      assert.ok(!JSON.stringify(failure).includes("Acme Corp"));
    } finally {
      stderr.restore();
      restore();
    }
  });
});

describe("withAudit — mandatory getAuth (regression guard)", () => {
  test("throws when options omitted", () => {
    assert.throws(
      () => withAudit("tool", async () => ({})),
      /getAuth.*mandatory/i
    );
  });
  test("throws when getAuth omitted", () => {
    assert.throws(
      () => withAudit("tool", async () => ({}), {}),
      /getAuth.*mandatory/i
    );
  });
});

describe("withAudit — MCP handler wrapping", () => {
  test("tier-1 auth: invokes handler untouched, zero fetch calls", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return fetchSuccess()();
    });
    try {
      const wrapped = withAudit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ tier: "tier-1" }), getSourceAgent: () => "claude" }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("live tier-3: invokes internalApi exactly once with correct field names, sourceAgent threaded through getSourceAgent()", async () => {
    let callCount = 0;
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      callCount += 1;
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      const wrapped = withAudit(
        "get_emissions_summary",
        async (params) => ({
          content: [{ type: "text", text: JSON.stringify({ result: { vendor: params.vendorName } }) }]
        }),
        { getAuth: () => buildAuth(), getSourceAgent: () => "chatgpt" }
      );
      const result = await wrapped({ vendorName: "Acme Corp" }, {});
      assert.equal(result.content[0].text.includes("Acme Corp"), true);
      assert.equal(callCount, 1);
      assert.equal(sentBody.tool, "get_emissions_summary");
      assert.equal(sentBody.sourceAgent, "chatgpt");
      assert.deepEqual(sentBody.inputs, { vendorName: "Acme Corp" });
    } finally {
      restore();
    }
  });

  test("missing getSourceAgent degrades to 'unknown' rather than throwing", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      const wrapped = withAudit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth() }
      );
      await wrapped({}, {});
      assert.equal(sentBody.sourceAgent, "unknown");
    } finally {
      restore();
    }
  });

  test("handler throws: records with an error-marker hash, then re-throws (error is never swallowed)", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      const wrapped = withAudit(
        "t1",
        async () => {
          throw new Error("handler blew up");
        },
        { getAuth: () => buildAuth(), getSourceAgent: () => "claude" }
      );
      await assert.rejects(() => wrapped({}, {}), /handler blew up/);
      assert.ok(sentBody, "expected the throw to still be recorded");
      assert.match(sentBody.resultHash, /^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  test("internalApi record failure: tool response is still returned to the caller", async () => {
    const restore = stubFetch(async () => ({
      ok: false,
      status: 503,
      text: async () => "unavailable"
    }));
    const stderr = captureStderr();
    try {
      const wrapped = withAudit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth(), getSourceAgent: () => "claude" }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("tier-3 handler returns an error envelope (not a throw): the call is still audited", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      const errorEnvelope = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: { code: "rate_limit_exceeded", http_status: 429 } })
          }
        ],
        isError: true
      };
      const wrapped = withAudit("t1", async () => errorEnvelope, {
        getAuth: () => buildAuth(),
        getSourceAgent: () => "claude"
      });
      const result = await wrapped({}, {});
      assert.equal(result.isError, true);
      assert.ok(sentBody, "a throttled/errored Tier-3 call is audit-worthy");
      assert.match(sentBody.resultHash, /^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });
});

describe("mcp_audit_missing_identity — anomalous Tier-3 auth", () => {
  test("withAudit: tier-3 non-test auth missing accountId emits the alert and does NOT write", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return fetchSuccess()();
    });
    const stderr = captureStderr();
    try {
      const wrapped = withAudit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ accountId: null }), getSourceAgent: () => "claude" }
      );
      const result = await wrapped({}, {});
      assert.equal(result.content[0].text, "ok");
      assert.equal(fetchCalled, false, "no audit write on a missing-identity call");
      const events = parseEmittedEvents(stderr.captured);
      const alert = events.find((e) => e.event === "mcp_audit_missing_identity");
      assert.ok(alert, "expected mcp_audit_missing_identity alert");
      assert.equal(alert.hasAccountId, false);
      assert.equal(alert.hasKeyId, true);
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("recordAuditEntry (REST path): tier-3 missing keyId emits the alert, no write", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return fetchSuccess()();
    });
    const stderr = captureStderr();
    try {
      await recordAuditEntry({
        auth: buildAuth({ keyId: null }),
        sourceAgent: "claude",
        toolName: "t1",
        inputs: {},
        response: {},
        latencyMs: 5
      });
      assert.equal(fetchCalled, false);
      const events = parseEmittedEvents(stderr.captured);
      assert.ok(events.find((e) => e.event === "mcp_audit_missing_identity"));
    } finally {
      stderr.restore();
      restore();
    }
  });

  test("a plain tier-1 no-op does NOT emit the missing-identity alert", async () => {
    const restore = stubFetch(async () => fetchSuccess()());
    const stderr = captureStderr();
    try {
      const wrapped = withAudit(
        "t1",
        async () => ({ content: [{ type: "text", text: "ok" }] }),
        { getAuth: () => buildAuth({ tier: "tier-1" }), getSourceAgent: () => "claude" }
      );
      await wrapped({}, {});
      const events = parseEmittedEvents(stderr.captured);
      assert.equal(
        events.find((e) => e.event === "mcp_audit_missing_identity"),
        undefined
      );
    } finally {
      stderr.restore();
      restore();
    }
  });
});

describe("runAudited — shared REST/MCP execution core", () => {
  test("success: runs the thunk, records the call, returns the thunk's result", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      const result = await runAudited({
        run: async () => ({ ok: "rest-result" }),
        auth: buildAuth(),
        sourceAgent: "chatgpt",
        toolName: "estimate_emissions",
        inputs: { spend: 100 }
      });
      assert.deepEqual(result, { ok: "rest-result" });
      assert.equal(sentBody.tool, "estimate_emissions");
      assert.equal(sentBody.sourceAgent, "chatgpt");
      assert.deepEqual(sentBody.inputs, { spend: 100 });
    } finally {
      restore();
    }
  });

  test("thunk throws: records an error-marker hash, then re-throws (REST throw path)", async () => {
    let sentBody = null;
    const restore = stubFetch(async (url, options) => {
      sentBody = JSON.parse(options.body);
      return fetchSuccess()();
    });
    try {
      await assert.rejects(
        () =>
          runAudited({
            run: async () => {
              throw new Error("rest handler blew up");
            },
            auth: buildAuth(),
            sourceAgent: "claude",
            toolName: "estimate_emissions",
            inputs: { spend: 100 }
          }),
        /rest handler blew up/
      );
      assert.ok(sentBody, "the thrown REST call must still be audited");
      assert.match(sentBody.resultHash, /^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  test("non-audited auth (tier-1): runs the thunk, no write", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return fetchSuccess()();
    });
    try {
      const result = await runAudited({
        run: async () => ({ ok: true }),
        auth: buildAuth({ tier: "tier-1" }),
        sourceAgent: "unknown",
        toolName: "estimate_emissions",
        inputs: {}
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchCalled, false);
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
