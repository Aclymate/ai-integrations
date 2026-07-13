import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const lists = require_("@aclymatepackages/lists");

const { industriesList, states } = lists;

const AVERAGE_INDUSTRY_FALLBACK = Object.freeze({
  label: null,
  buildingsSlug: "office",
  naics: null,
  scopeThreeCategory: null
});

// Delaware — verified empirically as the highest-emissions US state for a
// typical SMB using `buildDefaultEmissionsObj` across office/service/mercantile/
// foodService building types (162.5 tCO2e/yr for a 10-employee SMB, vs
// Colorado's 129.7 — ~25% higher). Chosen so the locationless fallback
// overshoots rather than under-reports, per Aclymate's overshoot preference
// for default-emissions tools (feedback_overshoot_emissions_estimates).
// Derived from `stateIndustriesKwhPerSqFt` + `stateIndustriesGasCfPerSqFt` +
// `oneWayCommuteMilesByState` in @aclymatepackages/calcs.
const FALLBACK_STATE = Object.freeze({
  abbreviation: "de",
  displayName: "Delaware",
  country: "us"
});

// Two-letter state/province abbreviations that also happen to be common
// English words. Skipped when scanning freeform prose so we don't tag
// "he lives in Denver" as Indiana, "hi there" as Hawaii, etc. State
// full-names are unambiguous, so only the abbrev path uses this list.
const ENGLISH_WORDS_SHADOWING_ABBREVS = new Set([
  "in",
  "or",
  "hi",
  "me",
  "de",
  "on",
  "la",
  "ma",
  "id",
  "ok",
  "wa",
  "co",
  "no",
  "so",
  "at",
  "as",
  "is",
  "it",
  "us",
  "we",
  "he",
  "al",
  "ct",
  "ar"
]);

const resolveIndustry = (industryString) => {
  const query =
    typeof industryString === "string"
      ? industryString.trim().toLowerCase()
      : "";
  if (!query) {
    return { industry: AVERAGE_INDUSTRY_FALLBACK, match: "fallback" };
  }

  const exact = industriesList.find(
    ({ label }) => label.toLowerCase() === query
  );
  if (exact) {
    return { industry: exact, match: "exact" };
  }

  const byPeopleDataLabs = industriesList.find(
    ({ peopleDataLabsIndustryType }) =>
      typeof peopleDataLabsIndustryType === "string" &&
      peopleDataLabsIndustryType.toLowerCase() === query
  );
  if (byPeopleDataLabs) {
    return { industry: byPeopleDataLabs, match: "people_data_labs" };
  }

  const substring = industriesList.find(({ label }) =>
    label.toLowerCase().includes(query)
  );
  if (substring) {
    return { industry: substring, match: "substring" };
  }

  return { industry: AVERAGE_INDUSTRY_FALLBACK, match: "fallback" };
};

const canonicalCountry = (rawCountry) => {
  if (rawCountry === "canada") {
    return "canada";
  }
  return "us";
};

const findStateByToken = (token) => {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const byAbbrev = states.find(
    ({ abbreviation }) => abbreviation === normalized
  );
  if (byAbbrev) {
    return byAbbrev;
  }
  return states.find(({ name }) => name === normalized) ?? null;
};

// Freeform-prose scan: state NAMES are unambiguous (no English collision),
// so match those first. State ABBREVIATIONS collide with common English
// words (see ENGLISH_WORDS_SHADOWING_ABBREVS) — skipped for abbrev
// substring matching. Callers who want to disambiguate ("Denver, CO")
// hit the comma-split `findStateByToken` path instead.
const findStateBySubstring = (locationLower) => {
  const byName = states.find(({ name }) => locationLower.includes(name));
  if (byName) {
    return byName;
  }
  const byAbbrev = states.find(({ abbreviation }) => {
    if (ENGLISH_WORDS_SHADOWING_ABBREVS.has(abbreviation)) {
      return false;
    }
    const pattern = new RegExp(`(^|[^a-z])${abbreviation}([^a-z]|$)`);
    return pattern.test(locationLower);
  });
  return byAbbrev ?? null;
};

const resolveLocation = (locationString) => {
  if (!locationString) {
    return {
      state: FALLBACK_STATE.abbreviation,
      country: FALLBACK_STATE.country,
      match: "fallback"
    };
  }

  const lower = locationString.toLowerCase();
  const parts = lower.split(",").map((segment) => segment.trim());
  const lastSegment = parts[parts.length - 1] ?? lower;

  const bySegment = findStateByToken(lastSegment);
  if (bySegment) {
    return {
      state: bySegment.abbreviation,
      country: canonicalCountry(bySegment.country),
      match: "state"
    };
  }

  const anywhere = findStateBySubstring(lower);
  if (anywhere) {
    return {
      state: anywhere.abbreviation,
      country: canonicalCountry(anywhere.country),
      match: "state"
    };
  }

  return {
    state: FALLBACK_STATE.abbreviation,
    country: FALLBACK_STATE.country,
    match: "unknown"
  };
};

export { resolveIndustry, resolveLocation, FALLBACK_STATE };
