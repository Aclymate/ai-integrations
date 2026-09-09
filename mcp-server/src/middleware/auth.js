import crypto from "node:crypto";
import { resolveApiKey } from "../internalApi.js";
import {
  buildAnonymousAuth,
  buildAuthenticatedAuth,
  buildScoutPlaceholderAuth
} from "../authContract.js";
import {
  buildErrorEnvelope,
  sendJson,
  UPGRADE_HINT_URL
} from "../responseEnvelope.js";

const BEARER_HEADER_PREFIX = "Bearer ";
const SCOUT_HEADER = "x-aclymate-scout-auth";
const METERING_BYPASS_HEADER = "x-aclymate-metering-bypass";
const MIN_METERING_BYPASS_SECRET_LENGTH = 16;

const STATUS_FOR_CODE = {
  malformed_auth_header: 401,
  invalid_api_key_format: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  internal_api_unavailable: 503
};

const MESSAGE_FOR_CODE = {
  malformed_auth_header:
    "The Authorization header must use the 'Bearer <key>' scheme.",
  invalid_api_key_format: "Malformed API key.",
  invalid_api_key: "Invalid API key.",
  revoked_api_key: "This API key has been revoked.",
  internal_api_unavailable:
    "Aclymate's internal API is temporarily unavailable. Please retry."
};

const hasScoutHeader = (req) => Boolean(req.headers?.[SCOUT_HEADER]);

// A header that IS present but doesn't start with "Bearer " (a typo'd scheme,
// e.g. "Bearr <key>") must be rejected distinctly from no header at all — a
// caller holding a valid key shouldn't be told they need one. Checked before
// extractBearerToken, which folds both cases into the same null return.
const hasMalformedAuthHeader = (req) => {
  const header = req.headers?.authorization;
  return Boolean(header) && !header.startsWith(BEARER_HEADER_PREFIX);
};

const extractBearerToken = (req) => {
  const header = req.headers?.authorization || "";
  if (!header.startsWith(BEARER_HEADER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_HEADER_PREFIX.length).trim();
  return token || null;
};

const emitStructuredWarning = (payload) => {
  process.stderr.write(JSON.stringify(payload) + "\n");
};

// Empty-secret guard: if MCP_INTERNAL_METERING_BYPASS_SECRET is absent, empty, or
// shorter than 16 chars, bypass is disabled unconditionally — no header value can
// match. Closes the universal-bypass hole a misconfigured Doppler entry would
// otherwise open (a bare crypto.timingSafeEqual("", "") returns true).
const isMeteringBypassSecretConfigured = () => {
  const secret = process.env.MCP_INTERNAL_METERING_BYPASS_SECRET || "";
  return secret.length >= MIN_METERING_BYPASS_SECRET_LENGTH;
};

const secretsMatch = (provided, expected) => {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
};

const resolveMeteringBypass = (req) => {
  const header = req.headers?.[METERING_BYPASS_HEADER];
  if (typeof header !== "string" || !header.length) {
    return false;
  }
  if (!isMeteringBypassSecretConfigured()) {
    return false;
  }
  const expected = process.env.MCP_INTERNAL_METERING_BYPASS_SECRET;
  if (secretsMatch(header, expected)) {
    emitStructuredWarning({
      event: "mcp_ip_meter_bypass_header_valid",
      level: "info"
    });
    return true;
  }
  emitStructuredWarning({ event: "mcp_ip_meter_bypass_header_invalid" });
  return false;
};

const denyResponse = (res, code) => {
  const status = STATUS_FOR_CODE[code] || 500;
  sendJson(
    res,
    status,
    buildErrorEnvelope({
      code,
      http_status: status,
      message: MESSAGE_FOR_CODE[code] || "Authentication failed.",
      upgradeHint: null
    })
  );
};

// A real HTTP 401/503 here works for our own REST routes (Aclymate's envelope shape),
// but for /mcp it kills the connection before the MCP protocol layer ever starts — the
// StreamableHTTPClientTransport only special-cases 401 when the client is configured
// with an OAuth authProvider (irrelevant to our static bearer scheme); otherwise it just
// throws and most MCP client UIs (Claude Desktop via mcp-remote) surface that as a bare
// "Server disconnected", not a readable message, because the auth failure never took the
// shape of a JSON-RPC response the client already knows how to parse and reject cleanly.
// Sending 200 with a JSON-RPC error object routes it through that same, already-working
// code path instead. id is always null: this rejection happens before parseBody, by
// design, so we never learn the request's real id.
const AUTH_FAILURE_JSONRPC_CODE = -32010;

const denyJsonRpc = (res, code) => {
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: AUTH_FAILURE_JSONRPC_CODE,
      message: MESSAGE_FOR_CODE[code] || "Authentication failed.",
      data: { aclymate_code: code }
    }
  });
};

const resolveBearerAuth = async (token, req) => {
  const result = await resolveApiKey(token);
  if (result.ok) {
    return { ok: true, auth: buildAuthenticatedAuth(req, result.data) };
  }
  return result;
};

const authMiddleware = async (req, res, { protocol = "envelope" } = {}) => {
  const deny = protocol === "jsonrpc" ? denyJsonRpc : denyResponse;

  if (hasScoutHeader(req)) {
    if (req.headers?.authorization) {
      emitStructuredWarning({
        event: "auth_conflicting_headers",
        detail:
          "scout-private header + Authorization both present; scout wins"
      });
    }
    req.auth = buildScoutPlaceholderAuth(req);
    return { proceed: true };
  }

  if (hasMalformedAuthHeader(req)) {
    deny(res, "malformed_auth_header");
    return { proceed: false };
  }

  const token = extractBearerToken(req);
  if (!token) {
    req.auth = buildAnonymousAuth(req, {
      meteringBypass: resolveMeteringBypass(req)
    });
    return { proceed: true };
  }

  const result = await resolveBearerAuth(token, req);
  if (result.ok) {
    req.auth = result.auth;
    return { proceed: true };
  }

  if (result.kind === "outage") {
    emitStructuredWarning({
      event: "internal_api_outage_on_authenticated_request",
      isTimeout: Boolean(result.isTimeout)
    });
    deny(res, "internal_api_unavailable");
    return { proceed: false };
  }

  deny(res, result.code);
  return { proceed: false };
};

// /mcp needs auth failures shaped as a JSON-RPC response (see denyJsonRpc) instead of
// Aclymate's REST envelope — bound here so handleMcpRoute can drop it straight into
// withMiddleware(...) alongside every other middleware, which only ever calls (req, res).
const authMiddlewareForJsonRpc = (req, res) =>
  authMiddleware(req, res, { protocol: "jsonrpc" });

export {
  authMiddleware,
  authMiddlewareForJsonRpc,
  resolveBearerAuth,
  UPGRADE_HINT_URL,
  STATUS_FOR_CODE,
  MESSAGE_FOR_CODE
};
