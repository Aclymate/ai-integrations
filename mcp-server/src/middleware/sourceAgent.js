const SCOUT_HEADER = "x-aclymate-scout-auth";
const SOURCE_HEADER = "x-aclymate-source";

const KNOWN_AGENTS = Object.freeze(["claude", "chatgpt", "gemini"]);

const USER_AGENT_MATCHERS = Object.freeze([
  ["claude", "claude"],
  ["chatgpt", "chatgpt"],
  ["gemini", "gemini"]
]);

// Exported for reuse by the future B-Tier3-audit ticket (mcp-audit-log.source_agent) —
// do not re-derive source-agent detection in a second module. See spec OQ1.
// Precedence: (1) scout, (2) explicit x-aclymate-source header if a known agent,
// (3) User-Agent heuristic, (4) unknown. Callers compute this once at the request
// boundary (server.js) and thread the value to consuming middleware.
const detectSourceAgent = (req, auth) => {
  if (auth?.pendingScoutAuth || req?.headers?.[SCOUT_HEADER]) {
    return "scout";
  }

  const explicitSource = (req?.headers?.[SOURCE_HEADER] || "").toLowerCase();
  if (KNOWN_AGENTS.includes(explicitSource)) {
    return explicitSource;
  }

  const userAgent = (req?.headers?.["user-agent"] || "").toLowerCase();
  const matched = USER_AGENT_MATCHERS.find(([needle]) =>
    userAgent.includes(needle)
  );
  return matched ? matched[1] : "unknown";
};

export { detectSourceAgent };
