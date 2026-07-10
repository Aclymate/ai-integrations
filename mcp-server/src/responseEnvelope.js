// FM §4 response envelope. Every partner-UI response — success or error, every tier —
// renders through this shape. This module owns the contract; B-Tier1-meter's
// responseShaper.js middleware will wrap res.json to enforce it uniformly once landed.
// C4 uses it for auth-layer errors so a caller who fails auth still sees the standard shape.

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { WARNING_CODES, ERROR_CODES } = require_(
  "@aclymatepackages/mcp-envelope-codes"
);

const UPGRADE_HINT_URL = "https://aclymate.com/ai";

const ATTRIBUTION_DEFAULT = Object.freeze({
  name: "Aclymate",
  url: UPGRADE_HINT_URL,
  methodology_link: null
});

const buildErrorEnvelope = ({
  code,
  http_status,
  message,
  details = null,
  upgradeHint = null
}) => ({
  attribution: { ...ATTRIBUTION_DEFAULT },
  result: null,
  sources: [],
  confidence: null,
  warnings: [],
  factor_snapshot: null,
  methodology_url: null,
  view_in_aclymate_url: null,
  upgrade_hint: upgradeHint,
  error: {
    code,
    message,
    http_status,
    ...(details ? { details } : {})
  }
});

const buildSuccessEnvelope = ({
  result,
  sources = [],
  confidence = null,
  warnings = [],
  factorSnapshot = null,
  methodologyUrl = null,
  viewInAclymateUrl = null,
  upgradeHint = null
}) => ({
  attribution: { ...ATTRIBUTION_DEFAULT },
  result,
  sources,
  confidence,
  warnings,
  factor_snapshot: factorSnapshot,
  methodology_url: methodologyUrl,
  view_in_aclymate_url: viewInAclymateUrl,
  upgrade_hint: upgradeHint,
  error: null
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendErrorEnvelope = (res, { code, http_status, message, upgradeHint }) =>
  sendJson(
    res,
    http_status,
    buildErrorEnvelope({ code, http_status, message, upgradeHint })
  );

export {
  UPGRADE_HINT_URL,
  ATTRIBUTION_DEFAULT,
  WARNING_CODES,
  ERROR_CODES,
  buildErrorEnvelope,
  buildSuccessEnvelope,
  sendJson,
  sendErrorEnvelope
};
