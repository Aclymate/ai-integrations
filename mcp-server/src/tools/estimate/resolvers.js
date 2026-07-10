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

// Colorado — Aclymate HQ. Used as a documented reference anchor when the
// caller omits location. Chosen so the calc has a real state to consume;
// paired with a default_used warning so downstream UIs surface it.
const FALLBACK_STATE = Object.freeze({
  abbreviation: "co",
  country: "us"
});

const resolveIndustry = (industryString) => {
  const query = industryString.trim().toLowerCase();

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

const findStateBySubstring = (locationLower) => {
  const byName = states.find(({ name }) => locationLower.includes(name));
  if (byName) {
    return byName;
  }
  const byAbbrev = states.find(({ abbreviation }) => {
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
