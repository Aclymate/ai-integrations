import { createHash } from "node:crypto";

import { recordAuditLogEntry } from "../internalApi.js";
import { emitStructuredWarning } from "./upgradeHints.js";

const REDACTION_MAX_DEPTH = 6;

const shouldAudit = (auth) =>
  Boolean(auth) &&
  auth.tier === "tier-3" &&
  !auth.testMode &&
  Boolean(auth.accountId) &&
  Boolean(auth.keyId);

// A live Tier-3 call that resolved without an accountId/keyId should be
// impossible (C4's resolver always supplies both). If it happens, the call is
// NOT audited (shouldAudit is false) — but silently dropping a Tier-3 call is
// exactly what the SOC-2 posture forbids, so surface it as a monitored alert
// rather than letting it look like a Tier-1 no-op.
const hasMissingTier3Identity = (auth) =>
  Boolean(auth) &&
  auth.tier === "tier-3" &&
  !auth.testMode &&
  (!auth.accountId || !auth.keyId);

const emitMissingIdentityIfAnomalous = (auth, toolName) => {
  if (hasMissingTier3Identity(auth)) {
    emitStructuredWarning({
      event: "mcp_audit_missing_identity",
      tool: toolName,
      hasAccountId: Boolean(auth.accountId),
      hasKeyId: Boolean(auth.keyId)
    });
  }
};

const hashResult = (response) => {
  try {
    return createHash("sha256").update(JSON.stringify(response)).digest("hex");
  } catch {
    return createHash("sha256").update(String(response)).digest("hex");
  }
};

const typeToken = (value) => {
  if (value === null) {
    return "<null>";
  }
  if (Array.isArray(value)) {
    return "<array>";
  }
  const type = typeof value;
  if (type === "string") {
    return `<string:${value.length}>`;
  }
  return `<${type}>`;
};

// Pure, recursive, structure-preserving redactor: every leaf → a type token,
// keys preserved, depth-capped. Intended for the Cloud-Logging path (any
// warning or Sentry breadcrumb that needs to carry input SHAPE).
//
// NOT YET WIRED into a production log line: today the audit warnings
// (emitStructuredWarning below) deliberately omit `inputs` entirely, which is
// strictly safer than logging even a redacted shape. This is exported +
// unit-tested so the next code that DOES need to log input shape reaches for
// this instead of logging raw values. Never applied to the value stored in the
// customer's own mcp-audit-log doc — see "Two-destination redaction" in the
// spec's Key Implementation Notes.
const redactForLogging = (value, depth = 0) => {
  if (depth >= REDACTION_MAX_DEPTH) {
    return typeToken(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactForLogging(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactForLogging(entry, depth + 1)
      ])
    );
  }
  return typeToken(value);
};

const ERROR_MARKER_RESPONSE = Object.freeze({ auditMarker: "handler_threw" });

// Transport-agnostic core, called by both the MCP surface (withAudit) and the
// REST surface (server.js's handleRestRoute post-hook). Awaited by both — a
// dropped un-awaited promise on Cloud Run's freeze-on-flush model is silent
// audit loss, which SOC 2 won't accept. A recording failure only alerts; it
// never fails the tool call.
const recordAuditEntry = async ({
  auth,
  sourceAgent,
  toolName,
  inputs,
  response,
  latencyMs
}) => {
  if (!shouldAudit(auth)) {
    emitMissingIdentityIfAnomalous(auth, toolName);
    return;
  }
  try {
    const outcome = await recordAuditLogEntry({
      companyId: auth.accountId,
      keyId: auth.keyId,
      tool: toolName,
      inputs,
      resultHash: hashResult(response),
      sourceAgent,
      latencyMs
    });
    if (!outcome.ok) {
      emitStructuredWarning({
        event: "mcp_audit_record_failed",
        tool: toolName,
        kind: outcome.kind,
        code: outcome.code
      });
    }
  } catch (err) {
    emitStructuredWarning({
      event: "mcp_audit_record_failed",
      tool: toolName,
      code: "internal_api_exception",
      message: err?.message
    });
  }
};

// Shared audited-execution core behind BOTH surfaces (withAudit for MCP,
// executeAndAudit in server.js for REST). Times the thunk, records the outcome
// — success OR throw — then returns the response / re-throws. On a throw it
// records a stable error-marker so a thrown Tier-3 tool hashes identically on
// either surface, and re-throws so the SDK / outer handler still surfaces the
// error (auditing never swallows a tool error). Callers own the shouldAudit
// hot-path short-circuit; recordAuditEntry itself no-ops when !shouldAudit, so
// routing a non-audited call through here is safe (just not free).
const runAudited = async ({ run, auth, sourceAgent, toolName, inputs }) => {
  const startedAt = Date.now();
  let response;
  try {
    response = await run();
  } catch (err) {
    await recordAuditEntry({
      auth,
      sourceAgent,
      toolName,
      inputs,
      response: ERROR_MARKER_RESPONSE,
      latencyMs: Date.now() - startedAt
    });
    throw err;
  }
  await recordAuditEntry({
    auth,
    sourceAgent,
    toolName,
    inputs,
    response,
    latencyMs: Date.now() - startedAt
  });
  return response;
};

// Outermost wrapper (MCP surface) — must observe the final response (incl.
// 429 / tier-gate errors from the inner metering/tierGate/rateLimit chain)
// and total latency. { getAuth } is mandatory (mirrors withMetering /
// withTierGate / withRateLimit); { getSourceAgent } is optional and defaults
// to "unknown" — source-agent detection is computed once per request in
// server.js via the shared detectSourceAgent(req, auth) (owned by
// middleware/sourceAgent.js) and threaded down as a closure, matching
// getAuth/getReq's convention.
const withAudit = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withAudit(${toolName}): { getAuth } is mandatory — do not silently bypass audit logging`
    );
  }
  const { getAuth, getSourceAgent } = options;
  return async (params, extra) => {
    const auth = getAuth();
    if (!shouldAudit(auth)) {
      emitMissingIdentityIfAnomalous(auth, toolName);
      return handler(params, extra);
    }
    const sourceAgent =
      typeof getSourceAgent === "function" ? getSourceAgent() || "unknown" : "unknown";
    return runAudited({
      run: () => handler(params, extra),
      auth,
      sourceAgent,
      toolName,
      inputs: params
    });
  };
};

export {
  shouldAudit,
  hashResult,
  redactForLogging,
  recordAuditEntry,
  runAudited,
  withAudit
};
