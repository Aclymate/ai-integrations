import { recordStoredResult } from "../internalApi.js";
import { emitStructuredWarning } from "./upgradeHints.js";
import { meetsTierRequirement } from "./toolTierGate.js";

const shouldSkip = (auth) => {
  if (!auth) {
    return true;
  }
  if (!auth.keyId) {
    return true;
  }
  // Rank-based, matching withTierGate's own access check — a tier-3 key
  // calling a Tier-2 tool must still be recorded, not silently dropped just
  // because its tier isn't the exact string "tier-2".
  if (!meetsTierRequirement(auth.tier, "tier-2")) {
    return true;
  }
  if (auth.testMode) {
    return true;
  }
  return false;
};

const fireAndForgetRecord = ({ toolName, auth, params, envelope, req }) => {
  // sourceAgent is computed once at the request boundary (server.js) and
  // threaded here via getReq() — never re-detected in this middleware.
  const sourceAgent = req?.sourceAgent || "unknown";
  recordStoredResult({
    accountId: auth.accountId,
    keyId: auth.keyId,
    tool: toolName,
    inputs: params,
    result: envelope.result,
    factorSnapshot: envelope.factor_snapshot,
    sourceAgent
  })
    .then((outcome) => {
      if (!outcome.ok) {
        emitStructuredWarning({
          event: "stored_result_record_denied",
          toolName,
          kind: outcome.kind,
          code: outcome.code
        });
      }
    })
    .catch((err) => {
      emitStructuredWarning({
        event: "stored_result_record_exception",
        toolName,
        message: err?.message
      });
    });
};

// Insert as the innermost wrapper directly around the raw handler (before
// envelopeToContent stringifies the envelope) so this can inspect the
// structured {result, error, factor_snapshot} object directly. A successful
// calc's response to the caller must never fail because storage failed —
// the recordStoredResult call is fired without awaiting it in the response
// path. { getAuth } is mandatory (mirrors withRateLimit/withTierGate);
// { getReq } is optional — sourceAgent detection degrades to "unknown"
// without it rather than throwing.
const withStoredResults = (toolName, handler, options) => {
  if (!options || typeof options.getAuth !== "function") {
    throw new Error(
      `withStoredResults(${toolName}): { getAuth } is mandatory — do not silently bypass stored-result recording`
    );
  }
  const { getAuth, getReq } = options;
  return async (params, extra) => {
    const envelope = await handler(params, extra);
    const auth = getAuth();
    if (shouldSkip(auth) || envelope.error) {
      return envelope;
    }
    const req = typeof getReq === "function" ? getReq() : null;
    fireAndForgetRecord({ toolName, auth, params, envelope, req });
    return envelope;
  };
};

export { withStoredResults, shouldSkip };
