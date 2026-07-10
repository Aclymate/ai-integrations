// Shared envelope-injection helpers for the success-side `upgrade_hint` nudge.
// Extracted from rateLimit.js so metering.js (B-Tier1-meter) can reuse the same
// envelope/MCP-response injection logic without duplicating it. Callers build
// their own hint object shape and pass it in — this module doesn't know
// whether the hint is a rate-limit countdown or an IP-metering countdown.

const emitStructuredWarning = (payload) => {
  process.stderr.write(JSON.stringify(payload) + "\n");
};

const tryParseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const looksLikeEnvelope = (value) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, "upgrade_hint");

const applySuccessHintToEnvelope = (envelope, hint) => {
  if (!looksLikeEnvelope(envelope)) {
    return envelope;
  }
  if (envelope.upgrade_hint) {
    return envelope;
  }
  return {
    ...envelope,
    upgrade_hint: hint
  };
};

const applySuccessHintToMcpResponse = (
  response,
  hint,
  toolName,
  events = {}
) => {
  const eventNames = {
    multiBlock: "hint_skip_multi_block",
    invalidJson: "hint_skip_invalid_json",
    ...events
  };
  const content = response?.content;
  if (!Array.isArray(content) || content.length !== 1) {
    if (Array.isArray(content) && content.length > 1) {
      emitStructuredWarning({
        event: eventNames.multiBlock,
        toolName,
        blockCount: content.length
      });
    }
    return response;
  }
  const [firstBlock] = content;
  if (firstBlock?.type !== "text" || typeof firstBlock.text !== "string") {
    return response;
  }
  const parsed = tryParseJson(firstBlock.text);
  if (parsed === null) {
    emitStructuredWarning({
      event: eventNames.invalidJson,
      toolName,
      detail:
        "handler returned non-JSON text content — either legacy prose tool (expected) or envelope-serialization bug (unexpected)"
    });
    return response;
  }
  if (!looksLikeEnvelope(parsed)) {
    return response;
  }
  const injected = applySuccessHintToEnvelope(parsed, hint);
  return {
    ...response,
    content: [{ type: "text", text: JSON.stringify(injected) }]
  };
};

const buildRateLimitToolResponse = (envelope) => ({
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  isError: true
});

export {
  emitStructuredWarning,
  tryParseJson,
  looksLikeEnvelope,
  applySuccessHintToEnvelope,
  applySuccessHintToMcpResponse,
  buildRateLimitToolResponse
};
