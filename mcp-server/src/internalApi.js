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

const request = async ({ method, path, body }) => {
  const client = await getClient();
  const url = `${getBaseUrl()}${path}`;

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
    const status = err.response?.status ?? null;
    const isTimeout =
      err.name === "AbortError" || err.code === "ERR_CANCELED";
    const wrapped = new Error(
      isTimeout ? "internal_api_timeout" : err.message || "internal_api_unreachable"
    );
    wrapped.isTimeout = isTimeout;
    wrapped.isNetworkError = !err.response && !isTimeout;
    wrapped.status = status;
    wrapped.body = err.response?.data ?? null;
    if (status && status < 500) {
      wrapped.isResolutionError = true;
    }
    throw wrapped;
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

export { resolveApiKey, getToolRegistry };
