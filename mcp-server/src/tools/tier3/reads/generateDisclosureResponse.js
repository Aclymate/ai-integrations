import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { generateDisclosureResponse } from "../../../internalApi.js";
import { buildValidationError, mapReadError } from "./readEnvelope.js";

const MIN_QUESTION_LENGTH = 8;

const inputShape = {
  question: z
    .string()
    .min(MIN_QUESTION_LENGTH)
    .describe("The disclosure question to answer, grounded in your Aclymate data."),
  framework: z
    .enum(["cdp", "ecovadis", "rfp", "other"])
    .optional()
    .describe("Optional disclosure framework the answer should target.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "generate_disclosure_response",
  title: "Generate Disclosure Response",
  description:
    "Draft a CDP / EcoVadis / RFP disclosure answer grounded strictly in your company's Aclymate emissions data. The draft never introduces figures that are not in your Aclymate account; off-scope or unsupported questions are declined in the draft."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await generateDisclosureResponse({
    companyId: auth?.accountId,
    question: parsed.data.question,
    framework: parsed.data.framework
  });
  if (!result.ok) {
    return mapReadError(result);
  }

  const { warnings = [], ...data } = result.data || {};
  return buildSuccessEnvelope({ result: data, warnings });
};

export { definition, inputShape, handler };
