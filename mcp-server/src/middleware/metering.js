import { checkAndIncrementIpCounter } from "../internalApi.js";
import { getThresholds } from "../toolRegistry.js";
import {
  buildErrorEnvelope,
  sendJson,
  UPGRADE_HINT_URL
} from "../responseEnvelope.js";
import {
  emitStructuredWarning,
  applySuccessHintToEnvelope,
  applySuccessHintToMcpResponse,
  buildRateLimitToolResponse
} from "./upgradeHints.js";

const STATUS_FOR_CODE = {
  ip_daily_cap_exceeded: 429,
  internal_api_unavailable: 503
};

const FALLBACK_THRESHOLDS = Object.freeze({ dailyThreshold: 3, dailyCap: 10 });

const METERING_HINT_EVENTS = {
  multiBlock: "mcp_ip_meter_hint_skip_multi_block",
  invalidJson: "mcp_ip_meter_hint_skip_invalid_json"
};

// !auth: never happens downstream of authMiddleware, defensive only.
// keyId/testMode/pendingScoutAuth: authenticated + Scout callers have C6's
// per-key rate limit instead. meteringBypass: Aclymate-owned callers (office,
// CI, local dev) via the shared-secret header.
const shouldSkip = (auth) => {
  if (!auth) {
    return true;
  }
  if (auth.keyId) {
    return true;
  }
  if (auth.pendingScoutAuth) {
    return true;
  }
  if (auth.testMode) {
    return true;
  }
  if (auth.meteringBypass) {
    return true;
  }
  return false;
};

const resolveThresholds = (toolName) => {
  const entry = getThresholds(toolName);
  if (entry && entry.dailyThreshold !== null && entry.dailyCap !== null) {
    return entry;
  }
  emitStructuredWarning({
    event: "mcp_ip_meter_missing_threshold",
    toolName
  });
  return FALLBACK_THRESHOLDS;
};

const buildMeteringCountdownHint = (callsRemainingToday, toolName) => ({
  trigger: "conversion_nudge",
  message: `You have ${callsRemainingToday} more free calls to ${toolName} today. Get a free Explorer account for a higher daily limit at aclymate.com/ai.`,
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: callsRemainingToday
});

const MESSAGE_FOR_REASON = {
  per_tool_cap: (toolName) =>
    `Daily free-tier limit reached for ${toolName}. Get a free Explorer account for a higher daily limit at aclymate.com/ai.`,
  global_cap: () =>
    "Daily free-tier limit reached across Aclymate tools. Get a free Explorer account at aclymate.com/ai."
};

const buildIpDailyCapEnvelope = (reason, toolName) => {
  const message = (MESSAGE_FOR_REASON[reason] || MESSAGE_FOR_REASON.global_cap)(
    toolName
  );
  return buildErrorEnvelope({
    code: "ip_daily_cap_exceeded",
    http_status: STATUS_FOR_CODE.ip_daily_cap_exceeded,
    message,
    upgradeHint: {
      trigger: "ip_daily_cap_exceeded",
      message,
      cta_url: UPGRADE_HINT_URL,
      calls_remaining_today: 0
    }
  });
};

const evaluateMetering = async (auth, toolName) => {
  if (!auth.ipHash) {
    emitStructuredWarning({ event: "mcp_ip_meter_empty_client_ip", toolName });
  }
  const { dailyThreshold, dailyCap } = resolveThresholds(toolName);
  const result = await checkAndIncrementIpCounter({
    ipHash: auth.ipHash,
    toolName,
    dailyThreshold,
    dailyCap
  });
  if (!result.ok && result.kind === "outage") {
    emitStructuredWarning({
      event: "mcp_ip_meter_internalapi_outage",
      isTimeout: Boolean(result.isTimeout)
    });
    return { decision: "outage" };
  }
  if (!result.ok) {
    emitStructuredWarning({
      event: "mcp_ip_meter_denied_bad_invariant",
      detail:
        "counter endpoint returned 4xx despite valid inputs — treating as outage (permissive) per fail-closed-on-invariant-violation logic",
      code: result.code
    });
    return { decision: "outage" };
  }
  if (!result.data.allowed) {
    emitStructuredWarning({
      event: "mcp_ip_meter_blocked",
      toolName,
      ipHashSuffix: (auth.ipHash || "").slice(-8),
      reason: result.data.reason,
      perToolCount: result.data.perToolCount,
      totalCallsToday: result.data.totalCallsToday
    });
    return { decision: "blocked", reason: result.data.reason };
  }
  const callsRemainingToday = result.data.callsRemainingToday;
  if (result.data.perToolCount <= dailyThreshold) {
    return { decision: "allowed", inNudgeZone: false };
  }
  emitStructuredWarning({
    event: "mcp_ip_meter_nudge",
    toolName,
    callsRemainingToday
  });
  return {
    decision: "allowed",
    inNudgeZone: true,
    callsRemainingToday,
    dailyCap,
    dailyThreshold
  };
};

const attachMeterMeta = (req, evaluation, toolName) => {
  if (!evaluation.inNudgeZone) {
    return;
  }
  req.meter = {
    hint: buildMeteringCountdownHint(evaluation.callsRemainingToday, toolName),
    callsRemainingToday: evaluation.callsRemainingToday,
    dailyCap: evaluation.dailyCap,
    dailyThreshold: evaluation.dailyThreshold
  };
};

// Debit-first-refund-never — matches rateLimit.js: the counter increments
// BEFORE the tool handler runs, so a scraper burns quota just like a real
// caller. See rateLimit.js:183-190 for the full rationale.
const enforceMeteringForRest = (toolName) => async (req, res) => {
  if (shouldSkip(req.auth)) {
    return { proceed: true };
  }
  const evaluation = await evaluateMetering(req.auth, toolName);
  if (evaluation.decision === "allowed") {
    attachMeterMeta(req, evaluation, toolName);
    return { proceed: true };
  }
  if (evaluation.decision === "blocked") {
    sendJson(
      res,
      STATUS_FOR_CODE.ip_daily_cap_exceeded,
      buildIpDailyCapEnvelope(evaluation.reason, toolName)
    );
    return { proceed: false };
  }
  // outage: fail-open — never block an anonymous caller on our own infra blip.
  return { proceed: true };
};

const withMetering = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withMetering(${toolName}): { getAuth } is mandatory — do not silently bypass metering`
    );
  }
  const { getAuth } = options;
  return async (params, extra) => {
    const auth = getAuth();
    if (shouldSkip(auth)) {
      return handler(params, extra);
    }
    const evaluation = await evaluateMetering(auth, toolName);
    if (evaluation.decision === "allowed") {
      const response = await handler(params, extra);
      if (!evaluation.inNudgeZone) {
        return response;
      }
      return applySuccessHintToMcpResponse(
        response,
        buildMeteringCountdownHint(evaluation.callsRemainingToday, toolName),
        toolName,
        METERING_HINT_EVENTS
      );
    }
    if (evaluation.decision === "blocked") {
      return buildRateLimitToolResponse(
        buildIpDailyCapEnvelope(evaluation.reason, toolName)
      );
    }
    // outage: fail-open — run the handler as if metering were disabled.
    return handler(params, extra);
  };
};

export {
  enforceMeteringForRest,
  withMetering,
  shouldSkip,
  buildMeteringCountdownHint,
  buildIpDailyCapEnvelope,
  STATUS_FOR_CODE
};
