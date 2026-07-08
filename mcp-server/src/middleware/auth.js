import crypto from "node:crypto";

import { resolveApiKey } from "../internalApi.js";

const BEARER_HEADER_PREFIX = "Bearer ";
const SCOUT_HEADER = "x-aclymate-scout-auth";

const BEARER_ERROR_STATUS_MAP = {
  missing_bearer_token: 401,
  invalid_api_key_format: 401,
  invalid_api_key: 401,
  revoked_api_key: 401,
  tier_mismatch: 403,
  unknown_tool: 404,
  internal_api_unavailable: 503
};

const BEARER_ERROR_MESSAGE_MAP = {
  missing_bearer_token:
    "Authentication required. Provide an Aclymate API key in the Authorization header.",
  invalid_api_key_format: "Malformed API key.",
  invalid_api_key: "Invalid API key.",
  revoked_api_key: "This API key has been revoked.",
  tier_mismatch:
    "This tool requires a higher Aclymate tier. Upgrade at aclymate.com/pricing.",
  unknown_tool: "Requested tool is not registered.",
  internal_api_unavailable:
    "Aclymate's internal API is temporarily unavailable. Please retry."
};

const UPGRADE_HINT_URL = "https://aclymate.com/ai";

const getIpHashSalt = () => process.env.MCP_IP_HASH_SALT || "";

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const extractClientIp = (req) => {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
};

const buildIpHash = (req) => sha256Hex(`${getIpHashSalt()}::${extractClientIp(req)}`);

const buildTier1Auth = (req, extras = {}) => ({
  tier: "tier-1",
  accountId: null,
  keyId: null,
  testMode: false,
  rateLimit: null,
  ipHash: buildIpHash(req),
  pendingScoutAuth: false,
  ...extras
});

const buildErrorPayload = ({ code, http_status, upgradeHint = null }) => ({
  attribution: {
    name: "Aclymate",
    url: UPGRADE_HINT_URL,
    methodology_link: null
  },
  result: null,
  sources: [],
  confidence: null,
  warnings: [],
  factor_snapshot: null,
  methodology_url: null,
  view_in_aclymate_url: null,
  upgrade_hint: upgradeHint,
  error: {
    code,
    message: BEARER_ERROR_MESSAGE_MAP[code] || "Request failed.",
    http_status
  }
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendAuthError = (res, code, extras = {}) => {
  const status = BEARER_ERROR_STATUS_MAP[code] || 500;
  const payload = buildErrorPayload({
    code,
    http_status: status,
    upgradeHint: extras.upgradeHint
  });
  sendJson(res, status, payload);
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

const resolveBearerAuth = async (token, req) => {
  const result = await resolveApiKey(token);
  if (result.ok) {
    const { data } = result;
    return {
      ok: true,
      auth: {
        tier: data.tier,
        accountId: data.accountId,
        keyId: data.keyId,
        testMode: Boolean(data.testMode),
        rateLimit: typeof data.rateLimit === "number" ? data.rateLimit : null,
        ipHash: buildIpHash(req),
        pendingScoutAuth: false
      }
    };
  }
  if (result.isOutage) {
    return { ok: false, code: "internal_api_unavailable", isOutage: true };
  }
  return { ok: false, code: result.code || "invalid_api_key" };
};

const authMiddleware = async (req, res) => {
  if (hasScoutHeader(req)) {
    if (req.headers?.authorization) {
      process.stderr.write(
        "[auth] scout-private header + Authorization both present; scout wins\n"
      );
    }
    req.auth = buildTier1Auth(req, { pendingScoutAuth: true });
    return { proceed: true };
  }

  const token = extractBearerToken(req);
  if (!token) {
    req.auth = buildTier1Auth(req);
    return { proceed: true };
  }

  const result = await resolveBearerAuth(token, req);
  if (result.ok) {
    req.auth = result.auth;
    return { proceed: true };
  }

  if (result.isOutage) {
    process.stderr.write(
      "[auth] internalApi outage on authenticated request — failing closed\n"
    );
    sendAuthError(res, "internal_api_unavailable");
    return { proceed: false };
  }

  const upgradeHint =
    result.code === "missing_bearer_token"
      ? {
          trigger: "tier_403",
          message:
            "This tool requires an Aclymate API key. Get one free at aclymate.com/ai.",
          cta_url: UPGRADE_HINT_URL,
          calls_remaining_today: null
        }
      : null;
  sendAuthError(res, result.code, { upgradeHint });
  return { proceed: false };
};

export {
  authMiddleware,
  resolveBearerAuth,
  buildTier1Auth,
  buildErrorPayload,
  sendJson,
  sendAuthError,
  UPGRADE_HINT_URL
};
