import { z } from "zod";

import { buildSuccessEnvelope } from "../../../responseEnvelope.js";
import { resolveProductFootprint } from "../../../internalApi.js";
import { buildValidationError, mapReadError } from "./readEnvelope.js";

const inputShape = {
  product_id: z
    .string()
    .min(1)
    .describe("The id of one of your company's products.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_product_carbon_footprint",
  title: "Calculate Product Carbon Footprint",
  description:
    "Return the cradle-to-grave carbon footprint, in kgCO2e, for one of your company's products by product_id, with a materials/packaging/energy/travel/end-of-life breakdown. Units are kgCO2e (kilograms), not tCO2e. Requires an active Product Carbon Footprint subscription."
};

const handler = async (rawParams, { auth } = {}) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }

  const result = await resolveProductFootprint({
    companyId: auth?.accountId,
    productId: parsed.data.product_id
  });
  if (!result.ok) {
    return mapReadError(result);
  }

  const { warnings = [], ...data } = result.data || {};
  return buildSuccessEnvelope({ result: data, warnings });
};

export { definition, inputShape, handler };
