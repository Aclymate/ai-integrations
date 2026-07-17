import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const CALCS_VERSION = require_("@aclymatepackages/calcs/package.json").version;

const FACTOR_SNAPSHOT = Object.freeze({
  package: "@aclymatepackages/calcs",
  version: CALCS_VERSION
});

const SLUG_MAP = Object.freeze({
  calculate_transaction_emissions: "transaction-emissions",
  calculate_event_attendee_emissions: "event-attendee-emissions",
  calculate_event_total_emissions: "event-total-emissions"
});

const deriveConfidence = ({
  defaultsUsed = false,
  unknownRegion = false,
  isDefinitionalZero = false
}) => {
  if (isDefinitionalZero) {
    return null;
  }
  if (unknownRegion) {
    return "low";
  }
  if (defaultsUsed) {
    return "medium";
  }
  return "high";
};

const isValidCalcResult = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export { FACTOR_SNAPSHOT, SLUG_MAP, deriveConfidence, isValidCalcResult };
