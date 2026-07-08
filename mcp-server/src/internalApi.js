import { GoogleAuth } from "google-auth-library";

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

const getClient = () => {
  if (cachedClientPromise) {
    return cachedClientPromise;
  }
  const auth = new GoogleAuth();
  cachedClientPromise = auth.getIdTokenClient(getAudience());
  return cachedClientPromise;
};

const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("internal_api_timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

const buildResolutionError = (status, body) => {
  const err = new Error(body?.message || "internal_api_resolution_error");
  err.status = status;
  err.body = body;
  err.isResolutionError = status >= 400 && status < 500;
  return err;
};

const request = async ({ method, path, body }) => {
  const client = await getClient();
  const url = `${getBaseUrl()}${path}`;
  const options = {
    url,
    method,
    responseType: "json"
  };
  if (body !== undefined) {
    options.data = body;
    options.headers = { "Content-Type": "application/json" };
  }

  const response = await withTimeout(
    client.request(options),
    INTERNAL_API_TIMEOUT_MS
  ).catch((err) => {
    const wrapped = new Error(err.message || "internal_api_unreachable");
    wrapped.isNetworkError = !err.response;
    wrapped.status = err.response?.status ?? null;
    wrapped.body = err.response?.data ?? null;
    if (err.response?.status && err.response.status < 500) {
      wrapped.isResolutionError = true;
    }
    throw wrapped;
  });

  return response.data;
};

const resolveApiKey = async (token) => {
  try {
    const data = await request({
      method: "POST",
      path: "/api/v1/api-keys/resolve",
      body: { token }
    });
    return { ok: true, data };
  } catch (err) {
    if (err.isResolutionError) {
      return {
        ok: false,
        code: err.body?.code || "invalid_api_key",
        status: err.status
      };
    }
    return {
      ok: false,
      code: "internal_api_unavailable",
      status: 503,
      isOutage: true
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
