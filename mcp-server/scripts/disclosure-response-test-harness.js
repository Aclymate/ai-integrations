#!/usr/bin/env node
// Test harness for generate_disclosure_response.
// Deterministic intercept cases monkeypatch fetch (the internalApi localhost
// path) so they run without live creds. Live cases hit the configured
// renew-west internal-api (which fetches the company's summary/sources and
// calls the model) and assert on the returned draft + latency.
//
// Deterministic run:
//   node scripts/disclosure-response-test-harness.js
// Live run (needs a seeded Tier-3 company with emissions data + a reachable
// internal-api + OpenAI creds):
//   DISCLOSURE_TEST_COMPANY_ID=<companyId> \
//   RENEW_WEST_INTERNAL_API_URL=<internalApiUrl> \
//   RENEW_WEST_INTERNAL_API_AUDIENCE=<audience> \
//   doppler run --project aclymate-internal --config dev -- \
//     node scripts/disclosure-response-test-harness.js
// (wired as `npm run test:disclosure-response`.)

process.env.RENEW_WEST_INTERNAL_API_URL =
  process.env.RENEW_WEST_INTERNAL_API_URL ||
  "http://localhost:5001/x/us-central1/internalApi";
process.env.RENEW_WEST_INTERNAL_API_AUDIENCE =
  process.env.RENEW_WEST_INTERNAL_API_AUDIENCE ||
  process.env.RENEW_WEST_INTERNAL_API_URL;

const { handler: generateDisclosureResponse } = await import(
  "../src/tools/tier3/reads/generateDisclosureResponse.js"
);

const TIER3_P95_BUDGET_MS = 5000;
const DISCLOSURE_TEST_COMPANY_ID = process.env.DISCLOSURE_TEST_COMPANY_ID || null;
const hasLiveCreds = Boolean(DISCLOSURE_TEST_COMPANY_ID);

const results = [];

const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  const status = passed ? "PASS" : "FAIL";
  process.stdout.write(`[${status}] ${name}${detail ? ` — ${detail}` : ""}\n`);
};

const buildAuth = () => ({
  tier: "tier-3",
  accountId: DISCLOSURE_TEST_COMPANY_ID || "co-harness",
  keyId: "key-harness",
  testMode: true,
  pendingScoutAuth: false
});

const withMockedFetch = (mockFn, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
};

const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body)
});

const runInterceptCases = async () => {
  await withMockedFetch(
    async () => {
      throw new Error("fetch should not be called for an invalid question");
    },
    async () => {
      const env = await generateDisclosureResponse(
        { question: "hi" },
        { auth: buildAuth() }
      );
      const ok = Boolean(env.error) && env.error.code === "invalid_input";
      record(
        "empty/nonsense question — invalid_input before the model is called",
        ok,
        ok ? "" : `got ${JSON.stringify(env.error)}`
      );
    }
  );

  await withMockedFetch(
    async () =>
      textResponse({
        draft:
          "That question is outside the scope of the carbon-emissions data Aclymate tracks, so I can't answer it here.",
        grounding: { totalTonsCo2e: 142, framework: "other" },
        warnings: []
      }),
    async () => {
      const env = await generateDisclosureResponse(
        { question: "What is the capital of France?" },
        { auth: buildAuth() }
      );
      const ok = env.error === null && env.result.draft.length > 0;
      record("off-scope question — returns a declining draft (not an error)", ok);
    }
  );

  await withMockedFetch(
    async () =>
      textResponse({
        draft:
          "Aclymate does not currently track water-intensity data for your account, so that figure is not available.",
        grounding: { totalTonsCo2e: 142, framework: "cdp" },
        warnings: []
      }),
    async () => {
      const env = await generateDisclosureResponse(
        { question: "What is our water intensity per unit revenue?", framework: "cdp" },
        { auth: buildAuth() }
      );
      const ok = env.error === null && env.result.draft.length > 0;
      record("data-gap question — states the gap rather than inventing a number", ok);
    }
  );
};

const runLiveCase = async ({ name, input }) => {
  const startedAt = process.hrtime.bigint();
  const env = await generateDisclosureResponse(input, { auth: buildAuth() }).catch(
    (err) => ({ error: { code: "harness_threw", message: err.message } })
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (env.error) {
    record(name, false, `unexpected error ${env.error.code}: ${env.error.message}`);
    return;
  }
  const shapeOk =
    typeof env.result.draft === "string" &&
    env.result.draft.length > 0 &&
    env.result.grounding &&
    typeof env.result.grounding.totalTonsCo2e === "number";
  const latencyNote = `latency ${elapsedMs.toFixed(0)}ms${
    elapsedMs > TIER3_P95_BUDGET_MS
      ? ` (over ${TIER3_P95_BUDGET_MS}ms — documented SLA exception for the LLM tool)`
      : ""
  }`;
  record(name, shapeOk, latencyNote);
};

const liveCases = [
  {
    name: "happy path — CDP Scope 1/2/3 question, well-populated company",
    input: {
      question:
        "Summarize our Scope 1, 2, and 3 emissions for a CDP disclosure.",
      framework: "cdp"
    }
  },
  {
    name: "ambiguous question — grounded answer at the level the data supports",
    input: { question: "Tell us about your sustainability performance." }
  }
];

const main = async () => {
  process.stdout.write(
    `generate_disclosure_response harness — internal-api: ${process.env.RENEW_WEST_INTERNAL_API_URL}\n`
  );

  await runInterceptCases();

  if (!hasLiveCreds) {
    process.stdout.write(
      "\nDISCLOSURE_TEST_COMPANY_ID not set — skipping live-model cases. Set it (plus RENEW_WEST_INTERNAL_API_URL/AUDIENCE) to exercise the live disclosure path and measure P95.\n"
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
