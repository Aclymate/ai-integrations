import emissionsFactors from "@aclymatepackages/emissions-factors";

const { listFactorsByType } = emissionsFactors;

const VEHICLE_FACTOR_TYPE = "vehicle";

let cachedVehicleRows = null;

const getVehicleRows = () => {
  if (!cachedVehicleRows) {
    cachedVehicleRows = listFactorsByType(VEHICLE_FACTOR_TYPE);
  }
  return cachedVehicleRows;
};

// Deterministic tie-break for candidates that share make + model-prefix + year:
// prefer gasoline (the common case), then sort by the full model string so
// repeated calls with the same input always resolve to the same row.
const pickBestCandidate = (candidates, fuelType) => {
  if (fuelType) {
    const exactFuel = candidates.filter(
      (row) => row.keys.fuel_type.toLowerCase() === fuelType.toLowerCase()
    );
    if (exactFuel.length) {
      return sortDeterministic(exactFuel)[0];
    }
  }
  const gasoline = candidates.filter(
    (row) => row.keys.fuel_type.toLowerCase() === "gasoline"
  );
  if (gasoline.length) {
    return sortDeterministic(gasoline)[0];
  }
  return sortDeterministic(candidates)[0];
};

const sortDeterministic = (rows) =>
  [...rows].sort(
    (a, b) =>
      a.keys.model.localeCompare(b.keys.model) ||
      a.keys.fuel_type.localeCompare(b.keys.fuel_type)
  );

// EFDB vehicle rows are keyed, not free-text (findFactorsBySearchTerm returns 0
// for "mazda cx-5") — but the model key itself carries a drivetrain suffix
// ("CX-5 2WD" / "CX-5 4WD") that a bare caller-supplied model never exact-matches.
// This does a keyed prefix match on model (still not a full-text fuzzy search)
// rather than the strictly-exact match, then disambiguates deterministically.
const resolveVehicleFactor = ({ make, model, year, fuelType }) => {
  if (!make || !model) {
    return { match: "none" };
  }

  const normalizedMake = String(make).trim().toLowerCase();
  const normalizedModel = String(model).trim().toLowerCase();

  const makeModelCandidates = getVehicleRows().filter(
    (row) =>
      row.keys.make.toLowerCase() === normalizedMake &&
      row.keys.model.toLowerCase().startsWith(normalizedModel)
  );

  if (!makeModelCandidates.length) {
    return { match: "none" };
  }

  const exactYearCandidates = year
    ? makeModelCandidates.filter((row) => row.keys.vehicle_year === year)
    : [];

  if (exactYearCandidates.length) {
    return {
      match: "exact",
      row: pickBestCandidate(exactYearCandidates, fuelType)
    };
  }

  const availableYears = [
    ...new Set(makeModelCandidates.map((row) => row.keys.vehicle_year))
  ].sort((a, b) => a - b);

  if (!availableYears.length) {
    return { match: "none" };
  }

  // No year requested at all — this isn't a fallback, it's the best answer to
  // an intentionally year-less query. Use the newest available year and treat
  // it as an exact match (no vehicle_year_fallback warning).
  if (!year) {
    const newestYear = availableYears[availableYears.length - 1];
    const newestYearCandidates = makeModelCandidates.filter(
      (row) => row.keys.vehicle_year === newestYear
    );
    return {
      match: "exact",
      row: pickBestCandidate(newestYearCandidates, fuelType)
    };
  }

  const nearestYear = availableYears.reduce((closest, candidateYear) =>
    Math.abs(candidateYear - year) < Math.abs(closest - year)
      ? candidateYear
      : closest
  );

  const nearestYearCandidates = makeModelCandidates.filter(
    (row) => row.keys.vehicle_year === nearestYear
  );

  return {
    match: "nearest_year",
    row: pickBestCandidate(nearestYearCandidates, fuelType),
    nearestYear
  };
};

export { resolveVehicleFactor };
