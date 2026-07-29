import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { getVendorBreakdown } from "../../../internalApi.js";
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
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of vendors to return (default 10).")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "get_vendor_breakdown",
  title: "Get Vendor Breakdown",
  description:
    "Return your company's own-vendor emissions breakdown from your Aclymate account, ranked by tCO2e, with per-vendor transaction counts. Scoped to your own vendors only."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await getVendorBreakdown({
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
