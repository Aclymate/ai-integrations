import crypto from "node:crypto";

// req.auth shape is a cross-repo contract consumed by every downstream Hill-M ticket:
// B-Tier1-meter (metering.js, responseShaper.js), C6 (rateLimit.js), B-Tier2-tools
// (storedResults.js), B-Tier3-audit (audit.js), D1/D2 (Scout wiring), every tool file.
// Do NOT duplicate this literal in another module — import from here.
const AUTH_FIELDS = Object.freeze([
  "tier",
  "accountId",
  "keyId",
  "testMode",
  "rateLimit",
  "ipHash",
  "pendingScoutAuth",
  "meteringBypass"
]);

const TIERS = Object.freeze(["tier-1", "tier-2", "tier-3"]);

const getIpHashSalt = () => process.env.MCP_IP_HASH_SALT || "";

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const extractClientIp = (req) => {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    // We trust x-forwarded-for[0] because mcp.aclymate.com is fronted by
    // Cloud Run's HTTPS load balancer (append-only). Do NOT deploy this
    // container without an LB in front — a direct-reachable deploy would
    // let clients forge ipHash and defeat IP-based Tier-1 metering.
    return forwarded.split(",")[0].trim();
  }
  return req?.socket?.remoteAddress || "";
};

const buildIpHash = (req) =>
  sha256Hex(`${getIpHashSalt()}::${extractClientIp(req)}`);

const buildAnonymousAuth = (req, { meteringBypass = false } = {}) => ({
  tier: "tier-1",
  accountId: null,
  keyId: null,
  testMode: false,
  rateLimit: null,
  ipHash: buildIpHash(req),
  pendingScoutAuth: false,
  meteringBypass
});

const buildAuthenticatedAuth = (req, resolved) => ({
  tier: normalizeTier(resolved.tier),
  accountId: resolved.accountId || null,
  keyId: resolved.keyId || null,
  testMode: Boolean(resolved.testMode),
  rateLimit:
    typeof resolved.rateLimit === "number" ? resolved.rateLimit : null,
  ipHash: buildIpHash(req),
  pendingScoutAuth: false,
  meteringBypass: false
});

const buildScoutPlaceholderAuth = (req) => ({
  ...buildAnonymousAuth(req),
  pendingScoutAuth: true
});

// Fail-CLOSED normalization: an unknown/absent tier collapses to tier-1
// (anonymous) intentionally, but the caller is expected to have already
// filtered out unauthenticated cases before reaching here. When we call
// this on the resolver's return value, an unrecognized value is a signal
// of drift between renew-west and the MCP server — log so we notice.
const normalizeTier = (raw) => {
  if (TIERS.includes(raw)) {
    return raw;
  }
  process.stderr.write(
    `[auth] unknown tier "${String(raw)}" — collapsing to tier-1 (renew-west/MCP drift?)\n`
  );
  return "tier-1";
};

export {
  AUTH_FIELDS,
  TIERS,
  buildAnonymousAuth,
  buildAuthenticatedAuth,
  buildScoutPlaceholderAuth,
  buildIpHash,
  normalizeTier
};
