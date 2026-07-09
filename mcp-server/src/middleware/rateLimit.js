import { checkAndIncrementRateLimit } from "../internalApi.js";
import {
  buildErrorEnvelope,
  sendJson,
  UPGRADE_HINT_URL
} from "../responseEnvelope.js";

const STATUS_FOR_CODE = {
  rate_limit_exceeded: 429,
  internal_api_unavailable: 503
};

const MESSAGE_FOR_CODE = {
  rate_limit_exceeded:
    "Daily rate limit exceeded. Upgrade at aclymate.com/ai.",
  internal_api_unavailable:
    "Aclymate's internal API is temporarily unavailable. Please retry."
};

const emitStructuredWarning = (payload) => {
  process.stderr.write(JSON.stringify(payload) + "\n");
};

const shouldSkip = (auth) => {
  if (!auth) {
    return true;
  }
  if (!auth.keyId) {
    return true;
  }
  if (auth.pendingScoutAuth) {
    return true;
  }
  if (auth.testMode) {
    return true;
  }
  return false;
};

const buildRateLimitHint = (callsRemainingToday) => ({
  trigger: "rate_limit_429",
  message:
    "Daily rate limit exceeded. Upgrade at aclymate.com/ai for a higher tier.",
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: callsRemainingToday
});

const buildSuccessCountdownHint = (callsRemainingToday) => ({
  trigger: "conversion_nudge",
  message: `${callsRemainingToday} calls remaining today. Upgrade at aclymate.com/ai for a higher daily limit.`,
  cta_url: UPGRADE_HINT_URL,
  calls_remaining_today: callsRemainingToday
});

const looksLikeEnvelope = (value) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, "upgrade_hint");

const applySuccessHintToEnvelope = (envelope, callsRemainingToday) => {
  if (!looksLikeEnvelope(envelope)) {
    return envelope;
  }
  if (envelope.upgrade_hint) {
    return envelope;
  }
  return {
    ...envelope,
    upgrade_hint: buildSuccessCountdownHint(callsRemainingToday)
  };
};

const applySuccessHintToMcpResponse = (response, callsRemainingToday) => {
  const content = response?.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return response;
  }
  const [firstBlock] = content;
  if (firstBlock?.type !== "text" || typeof firstBlock.text !== "string") {
    return response;
  }
  const parsed = tryParseJson(firstBlock.text);
  if (!looksLikeEnvelope(parsed)) {
    return response;
  }
  const injected = applySuccessHintToEnvelope(parsed, callsRemainingToday);
  return {
    ...response,
    content: [{ type: "text", text: JSON.stringify(injected) }]
  };
};

const tryParseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const buildRateLimitErrorEnvelope = ({ callsRemainingToday }) =>
  buildErrorEnvelope({
    code: "rate_limit_exceeded",
    http_status: STATUS_FOR_CODE.rate_limit_exceeded,
    message: MESSAGE_FOR_CODE.rate_limit_exceeded,
    upgradeHint: buildRateLimitHint(callsRemainingToday)
  });

const buildOutageErrorEnvelope = () =>
  buildErrorEnvelope({
    code: "internal_api_unavailable",
    http_status: STATUS_FOR_CODE.internal_api_unavailable,
    message: MESSAGE_FOR_CODE.internal_api_unavailable,
    upgradeHint: null
  });

const evaluateRateLimit = async (auth) => {
  if (auth.rateLimit === null || auth.rateLimit === undefined) {
    emitStructuredWarning({
      event: "rate_limit_missing_rate_limit_field",
      detail:
        "req.auth.rateLimit was null — C4 should always populate this; fallback applies internally in internalApi handler"
    });
  }
  const result = await checkAndIncrementRateLimit({
    companyId: auth.accountId,
    keyId: auth.keyId
  });
  if (!result.ok && result.kind === "outage") {
    emitStructuredWarning({
      event: "rate_limit_internalapi_outage",
      isTimeout: Boolean(result.isTimeout)
    });
    return { decision: "outage" };
  }
  if (!result.ok) {
    emitStructuredWarning({
      event: "rate_limit_internalapi_denied",
      code: result.code
    });
    return { decision: "outage" };
  }
  if (!result.data.allowed) {
    return {
      decision: "blocked",
      callsRemainingToday: result.data.callsRemainingToday
    };
  }
  return {
    decision: "allowed",
    callsRemainingToday: result.data.callsRemainingToday,
    dailyLimit: result.data.dailyLimit,
    resetAtIso: result.data.resetAtIso
  };
};

const attachRateLimitMeta = (req, evaluation) => {
  req.rateLimit = {
    callsRemainingToday: evaluation.callsRemainingToday,
    dailyLimit: evaluation.dailyLimit,
    resetAtIso: evaluation.resetAtIso
  };
};

const enforceRateLimitForRest = (toolName) => async (req, res) => {
  if (shouldSkip(req.auth)) {
    return { proceed: true };
  }
  const evaluation = await evaluateRateLimit(req.auth);
  if (evaluation.decision === "allowed") {
    attachRateLimitMeta(req, evaluation);
    return { proceed: true };
  }
  if (evaluation.decision === "blocked") {
    emitStructuredWarning({
      event: "rate_limit_blocked",
      toolName,
      keyMasked: req.auth.keyId ? `${req.auth.keyId.slice(-4)}` : null
    });
    sendJson(
      res,
      STATUS_FOR_CODE.rate_limit_exceeded,
      buildRateLimitErrorEnvelope({
        callsRemainingToday: evaluation.callsRemainingToday
      })
    );
    return { proceed: false };
  }
  sendJson(
    res,
    STATUS_FOR_CODE.internal_api_unavailable,
    buildOutageErrorEnvelope()
  );
  return { proceed: false };
};

const buildRateLimitToolResponse = (envelope) => ({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  isError: true
});

const withRateLimit = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withRateLimit(${toolName}): { getAuth } is mandatory — do not silently bypass rate-limit`
    );
  }
  const { getAuth } = options;
  return async (params, extra) => {
    const auth = getAuth();
    if (shouldSkip(auth)) {
      return handler(params, extra);
    }
    const evaluation = await evaluateRateLimit(auth);
    if (evaluation.decision === "allowed") {
      const response = await handler(params, extra);
      return applySuccessHintToMcpResponse(
        response,
        evaluation.callsRemainingToday
      );
    }
    if (evaluation.decision === "blocked") {
      emitStructuredWarning({
        event: "rate_limit_blocked_mcp",
        toolName
      });
      return buildRateLimitToolResponse(
        buildRateLimitErrorEnvelope({
          callsRemainingToday: evaluation.callsRemainingToday
        })
      );
    }
    return buildRateLimitToolResponse(buildOutageErrorEnvelope());
  };
};

export {
  enforceRateLimitForRest,
  withRateLimit,
  shouldSkip,
  applySuccessHintToEnvelope,
  buildSuccessCountdownHint,
  STATUS_FOR_CODE,
  MESSAGE_FOR_CODE
};
