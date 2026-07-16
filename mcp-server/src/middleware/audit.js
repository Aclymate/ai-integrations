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

// Pure, recursive, structure-preserving redaction used ONLY on the
// Cloud-Logging path (middleware warnings, Sentry breadcrumbs). Never applied
// to the value stored in the customer's own mcp-audit-log doc — see
// "Two-destination redaction" in the spec's Key Implementation Notes.
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

// Outermost wrapper (MCP surface) — must observe the final response (incl.
// 429 / tier-gate errors from the inner metering/tierGate/rateLimit chain)
// and total latency. { getAuth } is mandatory (mirrors withMetering /
// withTierGate / withRateLimit); { getSourceAgent } is mandatory here too —
// source-agent detection is computed once per request in server.js via the
// shared detectSourceAgent(req, auth) (owned by middleware/sourceAgent.js)
// and threaded down as a closure, matching getAuth/getReq's convention.
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
      return handler(params, extra);
    }
    const sourceAgent =
      typeof getSourceAgent === "function" ? getSourceAgent() || "unknown" : "unknown";
    const startedAt = Date.now();
    let response;
    try {
      response = await handler(params, extra);
    } catch (err) {
      await recordAuditEntry({
        auth,
        sourceAgent,
        toolName,
        inputs: params,
        response: ERROR_MARKER_RESPONSE,
        latencyMs: Date.now() - startedAt
      });
      throw err;
    }
    await recordAuditEntry({
      auth,
      sourceAgent,
      toolName,
      inputs: params,
      response,
      latencyMs: Date.now() - startedAt
    });
    return response;
  };
};

export {
  shouldAudit,
  hashResult,
  redactForLogging,
  recordAuditEntry,
  withAudit
};
