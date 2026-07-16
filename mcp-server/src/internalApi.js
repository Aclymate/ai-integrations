import { GoogleAuth } from "google-auth-library";

import { normalizeTier } from "./authContract.js";

const INTERNAL_API_TIMEOUT_MS = 5000;

const getBaseUrl = () => {
  const url = process.env.RENEW_WEST_INTERNAL_API_URL;
  if (!url) {
    throw new Error("RENEW_WEST_INTERNAL_API_URL is not set");
  }
  return url.replace(/\/$/, "");
};

const getAudience = () => {
  const audience = process.env.RENEW_WEST_INTERNAL_API_AUDIENCE;
  if (!audience) {
    throw new Error("RENEW_WEST_INTERNAL_API_AUDIENCE is not set");
  }
  return audience;
};

// Localhost bypass — for local dev against the Firebase functions emulator.
// The companion verifyOidcCaller.js in renew-west accepts requests without an
// OIDC token when FUNCTIONS_EMULATOR=true AND ENVIRONMENT!==production.
// Cannot activate on any prod URL by construction.
const isLocalUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

let cachedClientPromise = null;

// Only cache successful client init. A transient failure (e.g. DNS glitch during
// cold-start) must not poison the singleton — otherwise every subsequent request
// would reject with the same error until process restart.
const getClient = () => {
  if (cachedClientPromise) {
    return cachedClientPromise;
  }
  const auth = new GoogleAuth();
  const attempt = auth.getIdTokenClient(getAudience());
  cachedClientPromise = attempt.catch((err) => {
    cachedClientPromise = null;
    throw err;
  });
  return cachedClientPromise;
};

const wrapRequestError = (err) => {
  const status = err.response?.status ?? err.status ?? null;
  const isTimeout =
    err.name === "AbortError" || err.code === "ERR_CANCELED";
  const wrapped = new Error(
    isTimeout ? "internal_api_timeout" : err.message || "internal_api_unreachable"
  );
  wrapped.isTimeout = isTimeout;
  wrapped.isNetworkError = !err.response && !err.status && !isTimeout;
  wrapped.status = status;
  wrapped.body = err.response?.data ?? err.body ?? null;
  if (status && status < 500) {
    wrapped.isResolutionError = true;
  }
  return wrapped;
};

const localRequest = async ({ method, url, body }) => {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), INTERNAL_API_TIMEOUT_MS);
  const options = {
    method,
    headers: {},
    signal: controller.signal
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers["Content-Type"] = "application/json";
  }
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const err = new Error(`local emulator request failed: ${response.status}`);
      err.status = response.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } finally {
    clearTimeout(timeoutTimer);
  }
};

const request = async ({ method, path, body }) => {
  const url = `${getBaseUrl()}${path}`;

  if (isLocalUrl(url)) {
    process.stderr.write(
      `[internalApi] localhost bypass — request without OIDC (${method} ${path})\n`
    );
    try {
      return await localRequest({ method, url, body });
    } catch (err) {
      throw wrapRequestError(err);
    }
  }

  const client = await getClient();
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), INTERNAL_API_TIMEOUT_MS);
  const options = {
    url,
    method,
    responseType: "json",
    signal: controller.signal
  };
  if (body !== undefined) {
    options.data = body;
    options.headers = { "Content-Type": "application/json" };
  }
  try {
    const response = await client.request(options);
    return response.data;
  } catch (err) {
    throw wrapRequestError(err);
  } finally {
    clearTimeout(timeoutTimer);
  }
};

// Discriminated union return shape:
//   { ok: true, data: {...} }
//   { ok: false, kind: "denied", code, status }        — 401/403 from renew-west
//   { ok: false, kind: "outage", code, status, isTimeout } — 5xx / network / timeout
const resolveApiKey = async (token) => {
  try {
    const data = await request({
      method: "POST",
      path: "/api/v1/api-keys/resolve",
      body: { token }
    });
    return {
      ok: true,
      data: {
        accountId: data?.accountId || null,
        tier: normalizeTier(data?.tier),
        keyId: data?.keyId || null,
        testMode: Boolean(data?.testMode),
        rateLimit: typeof data?.rateLimit === "number" ? data.rateLimit : null
      }
    };
  } catch (err) {
    if (err.isResolutionError) {
      return {
        ok: false,
        kind: "denied",
        code: err.body?.code || "invalid_api_key",
        status: err.status
      };
    }
    return {
      ok: false,
      kind: "outage",
      code: "internal_api_unavailable",
      status: 503,
      isTimeout: Boolean(err.isTimeout)
    };
  }
};

const getToolRegistry = async () => {
  const data = await request({
    method: "GET",
    path: "/api/v1/mcp-tool-registry"
  });
  return data?.tools || [];
};

// Discriminated union return shape (mirrors resolveApiKey):
//   { ok: true, data: { allowed, callsRemainingToday, dailyLimit, resetAtIso } }
//   { ok: false, kind: "denied", code, status }
//   { ok: false, kind: "outage", code, status, isTimeout }
const checkAndIncrementRateLimit = async ({ companyId, keyId }) => {
  try {
    const data = await request({
      method: "POST",
      path: "/api/v1/api-keys/check-and-increment-counter",
      body: { companyId, keyId }
    });
    return {
      ok: true,
      data: {
        allowed: Boolean(data?.allowed),
        callsRemainingToday:
          typeof data?.callsRemainingToday === "number"
            ? data.callsRemainingToday
            : 0,
        dailyLimit:
          typeof data?.dailyLimit === "number" ? data.dailyLimit : null,
        resetAtIso:
          typeof data?.resetAtIso === "string" ? data.resetAtIso : null
      }
    };
  } catch (err) {
    if (err.isResolutionError) {
      return {
        ok: false,
        kind: "denied",
        code: err.body?.code || "invalid_api_key",
        status: err.status
      };
    }
    return {
      ok: false,
      kind: "outage",
      code: "internal_api_unavailable",
      status: 503,
      isTimeout: Boolean(err.isTimeout)
    };
  }
};

// Discriminated union return shape (mirrors checkAndIncrementRateLimit):
//   { ok: true, data: { allowed, reason, perToolCount, totalCallsToday, dailyThreshold, dailyCap, globalDailyCap, callsRemainingToday, resetAtIso } }
//   { ok: false, kind: "denied", code, status }
//   { ok: false, kind: "outage", code, status, isTimeout }
const checkAndIncrementIpCounter = async ({
  ipHash,
  toolName,
  dailyThreshold,
  dailyCap
}) => {
  try {
    const data = await request({
      method: "POST",
      path: "/api/v1/mcp-ip-counters/check-and-increment",
      body: { ipHash, toolName, dailyThreshold, dailyCap }
    });
    return {
      ok: true,
      data: {
        allowed: Boolean(data?.allowed),
        reason: data?.reason ?? null,
        perToolCount:
          typeof data?.perToolCount === "number" ? data.perToolCount : 0,
        totalCallsToday:
          typeof data?.totalCallsToday === "number" ? data.totalCallsToday : 0,
        dailyThreshold:
          typeof data?.dailyThreshold === "number" ? data.dailyThreshold : null,
        dailyCap: typeof data?.dailyCap === "number" ? data.dailyCap : null,
        globalDailyCap:
          typeof data?.globalDailyCap === "number" ? data.globalDailyCap : null,
        callsRemainingToday:
          typeof data?.callsRemainingToday === "number"
            ? data.callsRemainingToday
            : 0,
        resetAtIso:
          typeof data?.resetAtIso === "string" ? data.resetAtIso : null
      }
    };
  } catch (err) {
    if (err.isResolutionError) {
      return {
        ok: false,
        kind: "denied",
        code: err.body?.code || "invalid_input",
        status: err.status
      };
    }
    return {
      ok: false,
      kind: "outage",
      code: "internal_api_unavailable",
      status: 503,
      isTimeout: Boolean(err.isTimeout)
    };
  }
};

// Discriminated union return shape (mirrors checkAndIncrementRateLimit):
//   { ok: true, data: { resultId } }
//   { ok: false, kind: "denied", code, status }
//   { ok: false, kind: "outage", code, status, isTimeout }
const recordStoredResult = async ({
  accountId,
  keyId,
  tool,
  inputs,
  result,
  factorSnapshot,
  sourceAgent
}) => {
  try {
    const data = await request({
      method: "POST",
      path: "/api/v1/mcp-stored-results/record",
      body: { accountId, keyId, tool, inputs, result, factorSnapshot, sourceAgent }
    });
    return {
      ok: true,
      data: {
        resultId: data?.resultId || null
      }
    };
  } catch (err) {
    if (err.isResolutionError) {
      return {
        ok: false,
        kind: "denied",
        code: err.body?.code || "invalid_input",
        status: err.status
      };
    }
    return {
      ok: false,
      kind: "outage",
      code: "internal_api_unavailable",
      status: 503,
      isTimeout: Boolean(err.isTimeout)
    };
  }
};

export {
  resolveApiKey,
  getToolRegistry,
  checkAndIncrementRateLimit,
  checkAndIncrementIpCounter,
  recordStoredResult
};
