#!/usr/bin/env node
// Live-model test harness for recommend_emissions_reductions.
// Hits the real Climate Brain (knowledgeCompose) for the live cases and asserts
// on the parsed envelope. Deterministic intercept cases (parse failure, fence
// recovery, outage) monkeypatch fetch so they run without live creds.
//
// Run: doppler run --project aclymate-internal --config dev -- \
//        node scripts/recommend-emissions-reductions-test-harness.js
// (wired as `npm run test:recommend-emissions-reductions`).
// Exits non-zero on any envelope-shape violation or Zod-parse failure on valid
// inputs.

import { handler as recommendReductions } from "../src/tools/recommender/recommendEmissionsReductions.js";

const CLIMATE_BRAIN_URL =
  "https://us-central1-aclymate-internal.cloudfunctions.net/knowledgeCompose";

const hasLiveCreds = Boolean(process.env.INTERNAL_API_KEY);

const results = [];

const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  const status = passed ? "PASS" : "FAIL";
  process.stdout.write(`[${status}] ${name}${detail ? ` — ${detail}` : ""}\n`);
};

const withMockedFetch = (mockFn, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
};

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const isValidRecommendationArray = (recommendations) =>
  Array.isArray(recommendations) &&
  recommendations.length >= 3 &&
  recommendations.length <= 6 &&
  recommendations.every(
    (rec) =>
      typeof rec.title === "string" &&
      rec.title.length > 0 &&
      typeof rec.description === "string" &&
      rec.description.length > 0 &&
      ["1", "2", "3"].includes(rec.scope_targeted) &&
      ["high", "medium", "low"].includes(rec.impact_bucket) &&
      ["high", "medium", "low"].includes(rec.effort_bucket) &&
      typeof rec.first_step === "string" &&
      rec.first_step.length > 0
  );

const OFF_SCOPE_TERMS = ["offset", "certification", "framework"];

const runLiveCase = async ({ name, input, extraCheck }) => {
  const env = await recommendReductions(input).catch((err) => ({
    error: { code: "harness_threw", message: err.message }
  }));
  if (env.error) {
    record(name, false, `unexpected error ${env.error.code}: ${env.error.message}`);
    return;
  }
  if (!isValidRecommendationArray(env.result.recommendations)) {
    record(
      name,
      false,
      `recommendations did not satisfy the schema/count contract (got ${JSON.stringify(
        env.result.recommendations
      ).slice(0, 200)})`
    );
    return;
  }
  const extraDetail = extraCheck ? extraCheck(env) : "";
  record(name, true, extraDetail);
};

const liveCases = [
  {
    name: "happy path — Restaurants / 50 / scopeFocus 1 (scope_targeted predominantly '1')",
    input: { industry: "Restaurants", employees: 50, scopeFocus: "1" },
    extraCheck: (env) => {
      const scopeOnes = env.result.recommendations.filter(
        (rec) => rec.scope_targeted === "1"
      ).length;
      const ratio = scopeOnes / env.result.recommendations.length;
      return `scope_targeted '1' ratio: ${ratio.toFixed(2)}${
        ratio < 0.5 ? " (LOW — LLM bled across scopes, acceptable but logged)" : ""
      }`;
    }
  },
  {
    name: "ambiguous / partial — SaaS / 20 / no scopeFocus (defaults to all)",
    input: { industry: "SaaS", employees: 20 },
    extraCheck: (env) => {
      const scopes = new Set(
        env.result.recommendations.map((rec) => rec.scope_targeted)
      );
      return `distinct scopes covered: ${[...scopes].sort().join(",")}`;
    }
  },
  {
    name: "off-scope query — offsets in additionalContext should not leak into titles",
    input: {
      industry: "Restaurants",
      employees: 50,
      scopeFocus: "1",
      additionalContext: "we want to know about carbon offsets"
    },
    extraCheck: (env) => {
      const leaks = env.result.recommendations.filter((rec) =>
        OFF_SCOPE_TERMS.some((term) => rec.title.toLowerCase().includes(term))
      );
      return leaks.length
        ? `WARNING (not a hard gate): ${leaks.length} title(s) mention off-scope terms — log for prompt tuning`
        : "no off-scope terms in titles";
    }
  },
  {
    name: "nonsense industry — asdfghjkl / 20 falls back to office-typical",
    input: { industry: "asdfghjkl", employees: 20 },
    extraCheck: (env) => {
      const hasDefaultUsed = env.warnings.some((w) => w.code === "default_used");
      const fallbackLabel = env.result.industry_resolved.label === null;
      return `default_used=${hasDefaultUsed}, industry_resolved.label=null:${fallbackLabel}`;
    }
  },
  {
    name: "out-of-range value — Restaurants / 50000 accepted with SMB-calibration warning",
    input: { industry: "Restaurants", employees: 50000 },
    extraCheck: (env) => {
      const hasDefaultUsed = env.warnings.some((w) => w.code === "default_used");
      return `confidence=${env.confidence}, default_used=${hasDefaultUsed}`;
    }
  }
];

const runInterceptCases = async () => {
  await withMockedFetch(
    async () =>
      jsonResponse({
        response: "here are some ideas: 1. do a thing 2. do another thing"
      }),
    async () => {
      const env = await recommendReductions({
        industry: "Restaurants",
        employees: 20
      });
      const ok =
        env.error === null &&
        env.result.recommendations === null &&
        typeof env.result.raw_text === "string" &&
        env.warnings.some((w) => w.code === "structured_output_parse_failed");
      record("structured-output parse failure — falls back to raw_text", ok);
    }
  );

  await withMockedFetch(
    async () =>
      jsonResponse({
        response:
          "```json\n" +
          JSON.stringify(
            Array(3).fill({
              title: "Switch to renewable electricity",
              description: "Move grid power to a certified renewable tariff.",
              scope_targeted: "2",
              impact_bucket: "high",
              effort_bucket: "medium",
              first_step: "Request renewable-tariff quotes from three providers."
            })
          ) +
          "\n```"
      }),
    async () => {
      const env = await recommendReductions({
        industry: "Restaurants",
        employees: 20
      });
      record(
        "markdown-fence recovery — fenced JSON parses successfully",
        isValidRecommendationArray(env.result.recommendations)
      );
    }
  );

  await withMockedFetch(
    async () => jsonResponse({ error: "boom" }, 503),
    async () => {
      const env = await recommendReductions({
        industry: "Restaurants",
        employees: 20
      });
      const ok =
        Boolean(env.error) &&
        env.error.code === "climate_brain_unavailable" &&
        env.error.http_status === 503;
      record("Climate Brain outage — returns climate_brain_unavailable 503", ok);
    }
  );
};

const main = async () => {
  process.stdout.write(
    `recommend_emissions_reductions harness — Climate Brain: ${CLIMATE_BRAIN_URL}\n`
  );

  await runInterceptCases();

  if (!hasLiveCreds) {
    process.stdout.write(
      "\nINTERNAL_API_KEY not set — skipping live-model cases. Run via `doppler run --project aclymate-internal --config dev -- npm run test:recommend-emissions-reductions` to exercise the live model.\n"
    );
  }

  await liveCases.reduce(
    (chain, testCase) =>
      chain.then(() => (hasLiveCreds ? runLiveCase(testCase) : undefined)),
    Promise.resolve()
  );

  const failures = results.filter((r) => !r.passed);
  process.stdout.write(
    `\nHarness summary: ${results.length - failures.length}/${results.length} passed\n`
  );
  process.exit(failures.length ? 1 : 0);
};

main().catch((err) => {
  process.stderr.write(`harness crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});
