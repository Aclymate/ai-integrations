import { z } from "zod";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../responseEnvelope.js";
import { enrichPlaidTransactions } from "../../internalApi.js";

// Plaid's documented hard per-request max for /transactions/enrich
// (https://plaid.com/docs/api/products/enrich/, verified 2026-07-16).
const MAX_ENRICH_BATCH = 100;

const SOURCES = [{ name: "Plaid transactionsEnrich", vintage: "2026" }];

const inputShape = {
  transactions: z
    .array(
      z.object({
        description: z
          .string()
          .min(1)
          .describe("Raw transaction description/memo, as it appears on the statement."),
        amount: z
          .number()
          .describe(
            "Transaction amount in the transaction's currency. Positive for an outflow (money leaving the account), negative for an inflow."
          ),
        date: z
          .string()
          .describe("Transaction date, e.g. '2026-07-01' (YYYY-MM-DD)."),
        currencyCode: z
          .string()
          .default("USD")
          .describe("ISO currency code, defaults to USD.")
      })
    )
    .min(1)
    .max(MAX_ENRICH_BATCH)
    .describe(
      `Batch of raw transactions to classify, up to ${MAX_ENRICH_BATCH} per call.`
    ),
  accountType: z
    .enum(["depository", "credit"])
    .default("credit")
    .describe(
      "The account type the transactions came from — affects flow-type inference."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "categorize_transaction",
  title: "Categorize Transaction",
  description:
    "Classify a batch of raw bank/card transactions into vendors and emissions-relevant metadata (matched counterparty, flow type, location, Plaid personal-finance category). Wraps Aclymate's Plaid enrichment pipeline."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: "invalid_input",
    http_status: 400,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    upgradeHint: null
  });

const buildOutageError = () =>
  buildErrorEnvelope({
    code: "internal_api_unavailable",
    http_status: 503,
    message: "Aclymate's internal API is temporarily unavailable. Please retry.",
    upgradeHint: null
  });

const buildPlaidError = () =>
  buildErrorEnvelope({
    code: "plaid_enrichment_failed",
    http_status: 502,
    message: "Plaid was unable to enrich this batch of transactions. Please retry.",
    upgradeHint: null
  });

// Omits plaidRawTransactionData/plaidRequestId — the agent gets classifications,
// not Plaid internals.
const mapEnrichedTransaction = (raw) => ({
  description: raw.description ?? null,
  vendor: raw.vendor ?? null,
  flowType: raw.flowType ?? null,
  location: raw.location ?? null,
  personalFinanceCategory: raw.personal_finance_category ?? null,
  currencyCode: raw.currencyCode ?? null
});

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { transactions, accountType } = parsed.data;

  const outcome = await enrichPlaidTransactions({ transactions, accountType });
  if (!outcome.ok && outcome.kind === "outage") {
    return buildOutageError();
  }
  if (!outcome.ok) {
    return buildPlaidError();
  }

  return buildSuccessEnvelope({
    result: {
      transactions: outcome.data.enrichedTransactions.map(mapEnrichedTransaction)
    },
    sources: SOURCES,
    confidence: "high",
    warnings: [],
    factorSnapshot: null,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler, MAX_ENRICH_BATCH };
