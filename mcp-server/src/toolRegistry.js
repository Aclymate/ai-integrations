import { getToolRegistry as fetchToolRegistry } from "./internalApi.js";

const REGISTRY_TTL_MS = 5 * 60 * 1000;

let registryState = {
  loadedAt: null,
  byToolName: new Map()
};

let refreshTimer = null;

const indexByToolName = (tools) => {
  const validEntries = tools
    .filter((tool) => typeof tool?.toolName === "string")
    .map((tool) => [tool.toolName, tool]);
  return new Map(validEntries);
};

const warnOnMissingTier = (tool) => {
  if (!tool.tier) {
    process.stderr.write(
      `[mcp-tool-registry] tool "${tool.toolName}" is missing tier field — falling back to tier-1 conservatively\n`
    );
  }
};

const loadToolRegistry = async () => {
  const tools = await fetchToolRegistry();
  if (!tools.length) {
    throw new Error("mcp_tool_registry_empty");
  }
  tools.forEach(warnOnMissingTier);
  registryState = {
    loadedAt: Date.now(),
    byToolName: indexByToolName(tools)
  };
  return tools;
};

const refreshInBackground = () => {
  loadToolRegistry().catch((err) => {
    process.stderr.write(
      `[mcp-tool-registry] background refresh failed: ${err.message}\n`
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

const getTier = (toolName) => {
  const entry = getEntry(toolName);
  if (!entry) {
    return null;
  }
  return entry.tier || "tier-1";
};

const isRegistered = (toolName) => registryState.byToolName.has(toolName);

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

const listRegisteredTools = () => Array.from(registryState.byToolName.values());

export {
  loadToolRegistry,
  startRegistryRefresh,
  stopRegistryRefresh,
  getTier,
  isRegistered,
  getAttribution,
  getThresholds,
  listRegisteredTools
};
