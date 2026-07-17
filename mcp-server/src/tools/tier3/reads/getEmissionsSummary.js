import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { getEmissionsSummary } from "../../../internalApi.js";
import { buildValidationError, mapReadError } from "./readEnvelope.js";

const inputShape = {
  startDate: z
    .string()
    .optional()
    .describe("ISO start date (inclusive) for the reporting window."),
  endDate: z
    .string()
    .optional()
    .describe("ISO end date (inclusive) for the reporting window.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "get_emissions_summary",
  title: "Get Emissions Summary",
  description:
    "Return your company's Aclymate emissions summary — total tCO2e, a by-scope rollup, and a by-category breakdown — for an optional date range. Returns booked period totals from your Aclymate account; the current, still-aggregating period may lag the live dashboard estimate."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await getEmissionsSummary({
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
