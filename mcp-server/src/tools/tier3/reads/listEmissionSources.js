import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { listEmissionSources } from "../../../internalApi.js";
import { buildValidationError, mapReadError } from "./readEnvelope.js";

const inputShape = {
  startDate: z
    .string()
    .optional()
    .describe("ISO start date (inclusive) for the reporting window."),
  endDate: z
    .string()
    .optional()
    .describe("ISO end date (inclusive) for the reporting window."),
  groupBy: z
    .enum(["category", "vendor", "office", "employee"])
    .optional()
    .describe("How to group the ranked sources. Defaults to category."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of sources to return (default 10).")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "list_emission_sources",
  title: "List Emission Sources",
  description:
    "Return your company's ranked emission sources from your Aclymate account, grouped by category, vendor, office, or employee. Returns booked period totals; the current, still-aggregating period may lag the live dashboard estimate."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await listEmissionSources({
    companyId: auth?.accountId,
    ...parsed.data
  });
  if (!result.ok) {
    return mapReadError(result);
  }

  const { warnings = [], ...data } = result.data || {};
  return buildSuccessEnvelope({ result: data, warnings });
};

export { definition, inputShape, handler };
