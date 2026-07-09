import { getTier, isRegistered } from "../toolRegistry.js";
import {
  buildErrorEnvelope,
  sendJson,
  UPGRADE_HINT_URL
} from "../responseEnvelope.js";

const TIER_RANK = { "tier-1": 1, "tier-2": 2, "tier-3": 3 };

const rankFor = (tier) => TIER_RANK[tier] || 0;

const meetsTierRequirement = (userTier, toolTier) =>
  rankFor(userTier) >= rankFor(toolTier);

// Status is derived from code so the two can never drift.
const STATUS_FOR_CODE = {
  missing_bearer_token: 401,
  tier_mismatch: 403,
  unknown_tool: 404
};

const MESSAGE_FOR_CODE = {
  missing_bearer_token:
    "This tool requires an Aclymate API key. Get one free at aclymate.com/ai.",
  tier_mismatch:
    "This tool requires a higher Aclymate tier. Upgrade at aclymate.com/ai.",
  unknown_tool: "Requested tool is not registered."
};

const buildTierMismatchHint = () => ({
  trigger: "tier_403",
  message:
    "This tool requires a higher Aclymate tier. Upgrade at aclymate.com/ai.",
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: null
});

const buildMissingBearerTokenHint = () => ({
  trigger: "tier_403",
  message:
    "This tool requires an Aclymate API key. Get one free at aclymate.com/ai.",
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: null
});

// Discriminated result:
//   { allowed: true, toolTier }
//   { allowed: false, code, upgradeHint? }  — status derived by callers via STATUS_FOR_CODE
const evaluateToolAccess = (toolName, auth) => {
  if (!isRegistered(toolName)) {
    return { allowed: false, code: "unknown_tool" };
  }
  const toolTier = getTier(toolName);
  const userTier = auth?.tier || "tier-1";
  if (meetsTierRequirement(userTier, toolTier)) {
    return { allowed: true, toolTier };
  }
  const isUnauthed = !auth?.keyId;
  if (isUnauthed && toolTier !== "tier-1") {
    return {
      allowed: false,
      code: "missing_bearer_token",
      upgradeHint: buildMissingBearerTokenHint()
    };
  }
  return {
    allowed: false,
    code: "tier_mismatch",
    upgradeHint: buildTierMismatchHint()
  };
};

const denyResponse = (decision) => {
  const status = STATUS_FOR_CODE[decision.code] || 500;
  return {
    status,
    body: buildErrorEnvelope({
      code: decision.code,
      http_status: status,
      message: MESSAGE_FOR_CODE[decision.code] || "Access denied.",
      upgradeHint: decision.upgradeHint || null
    })
  };
};

const enforceToolTierForRest = (toolName) => (req, res) => {
  const decision = evaluateToolAccess(toolName, req.auth);
  if (decision.allowed) {
    return { proceed: true };
  }
  const { status, body } = denyResponse(decision);
  sendJson(res, status, body);
  return { proceed: false };
};

// `getAuth` is MANDATORY. Absent, we throw at registration time — do NOT default
// to a Tier-1 fallback that would silently anonymize the tool. This closes the
// footgun that the halt-gate self-review flagged in the first pass (a new tool
// added without `{getAuth}` would silently become Tier-1).
const buildTierMismatchToolResponse = (decision) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(denyResponse(decision).body)
    }
  ],
  isError: true
});

const withTierGate = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withTierGate(${toolName}): { getAuth } is mandatory — do not silently anonymize tools`
    );
  }
  const { getAuth } = options;
  return async (params, extra) => {
    const auth = getAuth();
    const decision = evaluateToolAccess(toolName, auth);
    if (!decision.allowed) {
      return buildTierMismatchToolResponse(decision);
    }
    return handler(params, extra);
  };
};

export {
  evaluateToolAccess,
  enforceToolTierForRest,
  withTierGate,
  meetsTierRequirement,
  STATUS_FOR_CODE,
  MESSAGE_FOR_CODE
};
