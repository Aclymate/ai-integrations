import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const emissionsFactors = require_("@aclymatepackages/emissions-factors");

const validKeyNamesCache = new Map();

const validKeyNamesForType = (factorType) => {
  if (validKeyNamesCache.has(factorType)) {
    return validKeyNamesCache.get(factorType);
  }
  const factors = emissionsFactors.listFactorsByType(factorType);
  const names = factors.reduce((acc, factor) => {
    Object.keys(factor.keys || {}).forEach((name) => acc.add(name));
    return acc;
  }, new Set());
  const sorted = [...names].sort();
  validKeyNamesCache.set(factorType, sorted);
  return sorted;
};

export { validKeyNamesForType };
