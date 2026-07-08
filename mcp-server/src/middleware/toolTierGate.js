import { getTier, isRegistered } from "../toolRegistry.js";
import {
  buildErrorPayload,
  sendJson,
  UPGRADE_HINT_URL
} from "./auth.js";

const TIER_RANK = {
  "tier-1": 1,
  "tier-2": 2,
  "tier-3": 3
};

const rankFor = (tier) => TIER_RANK[tier] || 0;

const meetsTierRequirement = (userTier, toolTier) =>
  rankFor(userTier) >= rankFor(toolTier);

const buildTierMismatchHint = (toolTier) => ({
  trigger: "tier_403",
  message: `This tool requires Aclymate ${
    toolTier === "tier-3" ? "Navigator (Tier-3)" : "Explorer (Tier-2)"
  }. Upgrade at aclymate.com/pricing.`,
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: null
});

const buildMissingBearerTokenHint = () => ({
  trigger: "tier_403",
  message: "This tool requires an Aclymate API key. Get one free at aclymate.com/ai.",
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: null
});

const evaluateToolAccess = (toolName, auth) => {
  if (!isRegistered(toolName)) {
    return { allowed: false, code: "unknown_tool", status: 404 };
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
      status: 401,
      upgradeHint: buildMissingBearerTokenHint()
    };
  }
  return {
    allowed: false,
    code: "tier_mismatch",
    status: 403,
    upgradeHint: buildTierMismatchHint(toolTier)
  };
};

const enforceToolTierForRest = (toolName) => (req, res) => {
  const decision = evaluateToolAccess(toolName, req.auth);
  if (decision.allowed) {
    return { proceed: true };
  }
  const payload = buildErrorPayload({
    code: decision.code,
    http_status: decision.status,
    upgradeHint: decision.upgradeHint || null
  });
  sendJson(res, decision.status, payload);
  return { proceed: false };
};

const DEFAULT_TIER1_AUTH = {
  tier: "tier-1",
  accountId: null,
  keyId: null,
  testMode: false,
  rateLimit: null,
  ipHash: null,
  pendingScoutAuth: false
};

const buildTierMismatchToolResponse = (decision) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        buildErrorPayload({
          code: decision.code,
          http_status: decision.status,
          upgradeHint: decision.upgradeHint || null
        })
      )
    }
  ],
  isError: true
});

const withTierGate = (toolName, handler, { getAuth } = {}) => async (
  params,
  extra
) => {
  const providedAuth =
    (typeof getAuth === "function" ? getAuth() : null) ||
    extra?.auth ||
    extra?.requestInfo?.auth ||
    DEFAULT_TIER1_AUTH;
  const decision = evaluateToolAccess(toolName, providedAuth);
  if (!decision.allowed) {
    return buildTierMismatchToolResponse(decision);
  }
  return handler(params, extra);
};

export {
  evaluateToolAccess,
  enforceToolTierForRest,
  withTierGate,
  meetsTierRequirement
};
