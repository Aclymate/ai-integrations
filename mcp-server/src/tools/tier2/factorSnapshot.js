import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const CALCS_VERSION = require_("@aclymatepackages/calcs/package.json").version;

const FACTOR_SNAPSHOT = Object.freeze({
  package: "@aclymatepackages/calcs",
  version: CALCS_VERSION
});

const SLUG_MAP = Object.freeze({
  classify_vendor_by_industry: "vendor-industry-classification",
  calculate_refrigerant_emissions: "refrigerant-emissions",
  calculate_steam_emissions: "steam-emissions",
  calculate_water_emissions: "water-emissions",
  calculate_vehicle_emissions: "vehicle-emissions",
  calculate_shipping_emissions: "shipping-emissions",
  calculate_commute_emissions: "commute-emissions",
  calculate_office_utility_emissions: "office-utility-emissions"
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
