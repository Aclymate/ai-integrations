import { getToolRegistry as fetchToolRegistry } from "./internalApi.js";

const REGISTRY_TTL_MS = 5 * 60 * 1000;

// Fail-CLOSED thresholds for stale-cache alerting. If the last successful fetch
// is older than STALE_ERROR_MS AND at least one refresh attempt has failed since,
// a downstream reader can decide to reject requests. We don't reject inside this
// module — we just publish the state.
const STALE_ERROR_MS = 30 * 60 * 1000;

let registryState = {
  loadedAt: null,
  lastRefreshErrorAt: null,
  lastRefreshError: null,
  byToolName: new Map()
};

let refreshTimer = null;

const indexByToolName = (tools) => {
  const validEntries = tools
    .filter((tool) => typeof tool?.toolName === "string")
    .map((tool) => [tool.toolName, tool]);
  return new Map(validEntries);
};

// Fail-LOUD at boot on empty registry. This gate is the only thing preventing
// an unseeded deploy from silently allowing every tool call.
const loadToolRegistry = async () => {
  const tools = await fetchToolRegistry();
  if (!tools.length) {
    throw new Error("mcp_tool_registry_empty");
  }
  registryState = {
    loadedAt: Date.now(),
    lastRefreshErrorAt: null,
    lastRefreshError: null,
    byToolName: indexByToolName(tools)
  };
  return tools;
};

const refreshInBackground = () => {
  loadToolRegistry().catch((err) => {
    registryState.lastRefreshErrorAt = Date.now();
    registryState.lastRefreshError = err.message;
    process.stderr.write(
      JSON.stringify({
        event: "mcp_tool_registry_refresh_failed",
        message: err.message,
        lastLoadedAt: registryState.loadedAt,
        staleMs: registryState.loadedAt
          ? Date.now() - registryState.loadedAt
          : null
      }) + "\n"
    );
  });
};

const startRegistryRefresh = () => {
  if (refreshTimer) {
    return;
  }
  refreshTimer = setInterval(refreshInBackground, REGISTRY_TTL_MS);
  if (typeof refreshTimer.unref === "function") {
    refreshTimer.unref();
  }
};

const stopRegistryRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
};

const getEntry = (toolName) => registryState.byToolName.get(toolName) || null;

// Fail-CLOSED: a registered tool with a missing/unknown tier field returns null
// so evaluateToolAccess treats it as unknown_tool (404) rather than silently
// downgrading to tier-1 (which would let anonymous callers invoke it).
const getTier = (toolName) => {
  const entry = getEntry(toolName);
  if (!entry) {
    return null;
  }
  if (!entry.tier) {
    process.stderr.write(
      JSON.stringify({
        event: "mcp_tool_registry_missing_tier",
        toolName,
        note: "tool will 404 until its registry doc has a `tier` field"
      }) + "\n"
    );
    return null;
  }
  return entry.tier;
};

const isRegistered = (toolName) => {
  const entry = getEntry(toolName);
  if (!entry) {
    return false;
  }
  return Boolean(entry.tier);
};

const getAttribution = (toolName) => {
  const entry = getEntry(toolName);
  return entry?.attributionRequired ?? false;
};

const getThresholds = (toolName) => {
  const entry = getEntry(toolName);
  if (!entry) {
    return null;
  }
  return {
    dailyThreshold: entry.dailyThreshold ?? null,
    dailyCap: entry.dailyCap ?? null
  };
};

const getRegistryHealth = () => ({
  loadedAt: registryState.loadedAt,
  lastRefreshErrorAt: registryState.lastRefreshErrorAt,
  lastRefreshError: registryState.lastRefreshError,
  toolCount: registryState.byToolName.size,
  isStale:
    registryState.lastRefreshErrorAt !== null &&
    registryState.loadedAt !== null &&
    Date.now() - registryState.loadedAt > STALE_ERROR_MS
});

const listRegisteredTools = () => Array.from(registryState.byToolName.values());

// Test-only escape hatch. Bypasses internalApi so smoke tests can seed the
// registry state without a live renew-west. Do NOT call from production code.
const __setRegistryForTests = (entries) => {
  registryState = {
    loadedAt: Date.now(),
    lastRefreshErrorAt: null,
    lastRefreshError: null,
    byToolName: indexByToolName(entries)
  };
};

export {
  loadToolRegistry,
  startRegistryRefresh,
  stopRegistryRefresh,
  getTier,
  isRegistered,
  getAttribution,
  getThresholds,
  getRegistryHealth,
  listRegisteredTools,
  STALE_ERROR_MS,
  REGISTRY_TTL_MS,
  __setRegistryForTests
};
