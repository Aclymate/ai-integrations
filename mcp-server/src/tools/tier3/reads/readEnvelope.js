import { buildErrorEnvelope } from "../../../responseEnvelope.js";

// Shared error-mapping for the Tier-3 read tools (mirrors the tier2/factorSnapshot.js
// shared-helper precedent). Turns a zod parse failure or an internalApi
// discriminated-union failure into the FM §4 error envelope.

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: "invalid_input",
    http_status: 400,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
  });

const mapReadError = (result) => {
  if (result.kind === "outage") {
    return buildErrorEnvelope({
      code: "internal_api_unavailable",
      http_status: 503,
      message:
        "The Aclymate data service is temporarily unavailable. Please try again."
    });
  }

  const ctaUrl = result.body?.upgrade_hint?.cta_url || null;
  const upgradeHint = result.body?.upgrade_hint
    ? { ...result.body.upgrade_hint, cta_url: ctaUrl }
    : null;

  return buildErrorEnvelope({
    code: result.code,
    http_status: result.status || 400,
    message: result.body?.message || "The request could not be completed.",
    upgradeHint
  });
};

export { buildValidationError, mapReadError };
