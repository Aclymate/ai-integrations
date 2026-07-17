import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { auditNumber } from "../../../internalApi.js";
import { buildValidationError, mapReadError } from "./readEnvelope.js";

const inputShape = {
  transactionId: z
    .string()
    .min(1)
    .describe("The id of one of your company's transactions to audit.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "audit_a_number",
  title: "Audit a Number",
  description:
    "Return the factor snapshot, methodology, and calc lineage behind one of your company's transactions. Only transactions belonging to your company can be audited."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await auditNumber({
    companyId: auth?.accountId,
    transactionId: parsed.data.transactionId
  });
  if (!result.ok) {
    return mapReadError(result);
  }

  const { warnings = [], ...data } = result.data || {};
  return buildSuccessEnvelope({
    result: data,
    warnings,
    methodologyUrl: data.lineage?.methodologyUrl || null
  });
};

export { definition, inputShape, handler };
