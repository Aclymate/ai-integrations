import { checkAndIncrementToolCounter } from "../internalApi.js";
import { buildErrorEnvelope, UPGRADE_HINT_URL } from "../responseEnvelope.js";
import { emitStructuredWarning } from "./upgradeHints.js";

// Per-tool daily call cap, on top of C6's per-key daily rate limit. Sized to
// hold worst-case rogue-key Plaid exposure to ~$25/day (see ticket
// 5GcBghpKHzY8ii9cyvfp spec) — real usage is ~80 calls/month, so 50/day is
// invisible to normal customers. Add an entry here (+ a batch limit on the
// tool itself) for any future Plaid-billed tool.
const TOOL_DAILY_CALL_CAPS = Object.freeze({
  categorize_transaction: 50
});

// Unlike withRateLimit's shouldSkip, this does NOT skip testMode — test keys
// hit real Plaid, so the cap must apply to them too (deliberate deviation).
const shouldSkip = (auth, toolName) => {
  if (!(toolName in TOOL_DAILY_CALL_CAPS)) {
    return true;
  }
  if (!auth?.keyId) {
    return true;
  }
  return false;
};

const buildCapUpgradeHint = () => ({
  trigger: "tool_daily_cap",
  message:
    "Daily categorize_transaction limit reached. Ingest transactions through Navigator bank sync for unlimited categorization at no per-call cost.",
  cta_url: UPGRADE_HINT_URL
});

const buildCapErrorEnvelope = () =>
  buildErrorEnvelope({
    code: "tool_daily_cap_reached",
    http_status: 429,
    message:
      "Daily categorize_transaction limit reached. Ingest transactions through Navigator bank sync for unlimited categorization at no per-call cost.",
    upgradeHint: buildCapUpgradeHint()
  });

const buildOutageErrorEnvelope = () =>
  buildErrorEnvelope({
    code: "internal_api_unavailable",
    http_status: 503,
    message: "Aclymate's internal API is temporarily unavailable. Please retry.",
    upgradeHint: null
  });

const withToolCallCap = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withToolCallCap(${toolName}): { getAuth } is mandatory — do not silently bypass the tool call cap`
    );
  }
  const { getAuth } = options;
  return async (params, extra) => {
    const auth = getAuth();
    if (shouldSkip(auth, toolName)) {
      return handler(params, extra);
    }

    const dailyLimit = TOOL_DAILY_CALL_CAPS[toolName];
    const outcome = await checkAndIncrementToolCounter({
      companyId: auth.accountId,
      keyId: auth.keyId,
      toolName,
      dailyLimit
    });

    // Any non-ok outcome (denied or outage) is fail-closed here — a "denied"
    // response would mean drift between auth resolution and the counter
    // endpoint (accountId/keyId already validated upstream by C4), same
    // fail-closed posture rateLimit.js takes for that drift case.
    if (!outcome.ok) {
      emitStructuredWarning({
        event: "tool_call_cap_internalapi_outage",
        toolName,
        kind: outcome.kind,
        isTimeout: Boolean(outcome.isTimeout)
      });
      return buildOutageErrorEnvelope();
    }

    if (!outcome.data.allowed) {
      emitStructuredWarning({
        event: "tool_call_cap_reached",
        toolName,
        keyMasked: auth.keyId ? auth.keyId.slice(-4) : null
      });
      return buildCapErrorEnvelope();
    }

    return handler(params, extra);
  };
};

export { withToolCallCap, shouldSkip, TOOL_DAILY_CALL_CAPS };
