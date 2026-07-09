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

const STATUS_FOR_CODE = {
  invalid_api_key_format: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  internal_api_unavailable: 503
};

const MESSAGE_FOR_CODE = {
  invalid_api_key_format: "Malformed API key.",
  invalid_api_key: "Invalid API key.",
  revoked_api_key: "This API key has been revoked.",
  internal_api_unavailable:
    "Aclymate's internal API is temporarily unavailable. Please retry."
};

const hasScoutHeader = (req) => Boolean(req.headers?.[SCOUT_HEADER]);

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

const resolveBearerAuth = async (token, req) => {
  const result = await resolveApiKey(token);
  if (result.ok) {
    return { ok: true, auth: buildAuthenticatedAuth(req, result.data) };
  }
  return result;
};

const authMiddleware = async (req, res) => {
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

  const token = extractBearerToken(req);
  if (!token) {
    req.auth = buildAnonymousAuth(req);
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
    denyResponse(res, "internal_api_unavailable");
    return { proceed: false };
  }

  denyResponse(res, result.code);
  return { proceed: false };
};

export {
  authMiddleware,
  resolveBearerAuth,
  UPGRADE_HINT_URL,
  STATUS_FOR_CODE,
  MESSAGE_FOR_CODE
};
