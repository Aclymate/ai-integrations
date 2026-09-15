// Converts a factor's value/unit into a requested unit, but ONLY when that unit is a
// simple, dimensionally-sound substitution within the SAME denominator family (distance,
// energy, or mass) — e.g. "kg CO2/passenger-km" -> "kg CO2/passenger-mile", or
// "g CO2/kWh" -> "g CO2/MWh". Never fabricates a conversion across families (e.g.
// "kg CO2/gallon" -> "kg CO2/mile" would need a fuel-efficiency assumption this catalog
// doesn't have) — callers must fall back to the native value/unit and surface an honest
// warning instead.

const UNIT_FAMILIES = {
  distance: {
    km: { size: 1, display: "km" },
    kilometer: { size: 1, display: "km" },
    kilometers: { size: 1, display: "km" },
    mile: { size: 1.609344, display: "mile" },
    miles: { size: 1.609344, display: "mile" },
    m: { size: 0.001, display: "m" },
    meter: { size: 0.001, display: "m" },
    meters: { size: 0.001, display: "m" }
  },
  energy: {
    kwh: { size: 1, display: "kWh" },
    mwh: { size: 1000, display: "MWh" },
    gwh: { size: 1000000, display: "GWh" }
  },
  mass: {
    kg: { size: 1, display: "kg" },
    kilogram: { size: 1, display: "kg" },
    kilograms: { size: 1, display: "kg" },
    lb: { size: 0.45359237, display: "lb" },
    lbs: { size: 0.45359237, display: "lb" },
    pound: { size: 0.45359237, display: "lb" },
    pounds: { size: 0.45359237, display: "lb" }
  }
};

const splitTokens = (value) =>
  String(value)
    .split(/[\s-]+/)
    .filter(Boolean);

const findFamilyMatch = (token) => {
  const key = token.toLowerCase();
  for (const [family, table] of Object.entries(UNIT_FAMILIES)) {
    if (key in table) return { family, ...table[key] };
  }
  return null;
};

// A requested unit like "per mile" or "per kWh" — take the first token that resolves to
// a known family member (usually the whole hint after stripping "per").
const parseRequestedUnit = (requestedUnit) => {
  const stripped = String(requestedUnit).trim().replace(/^per[\s-]+/i, "");
  for (const token of splitTokens(stripped)) {
    const match = findFamilyMatch(token);
    if (match) return match;
  }
  return null;
};

// Attempts to convert one (value, unitString) pair. Returns:
// - { status: "converted", value, unit }
// - { status: "already_native" } — requested unit is what the factor already uses
// - { status: "incompatible" } — no safe conversion exists; caller keeps the native value
const convertValueUnit = (value, unitString, requestedUnit) => {
  if (typeof value !== "number" || !unitString) {
    return { status: "incompatible" };
  }
  const target = parseRequestedUnit(requestedUnit);
  if (!target) return { status: "incompatible" };

  const slashIndex = unitString.lastIndexOf("/");
  if (slashIndex === -1) return { status: "incompatible" };
  const numerator = unitString.slice(0, slashIndex);
  const denominator = unitString.slice(slashIndex + 1);
  const denomTokens = splitTokens(denominator);

  let matchIndex = -1;
  let source = null;
  denomTokens.forEach((token, i) => {
    const match = findFamilyMatch(token);
    if (match && match.family === target.family) {
      matchIndex = i;
      source = match;
    }
  });
  if (matchIndex === -1) return { status: "incompatible" };
  if (source.display === target.display) return { status: "already_native" };

  const convertedValue = value * (target.size / source.size);
  const separator = denominator.includes("-") ? "-" : " ";
  const newDenomTokens = [...denomTokens];
  newDenomTokens[matchIndex] = target.display;
  return {
    status: "converted",
    value: convertedValue,
    unit: `${numerator}/${newDenomTokens.join(separator)}`
  };
};

export { convertValueUnit };
