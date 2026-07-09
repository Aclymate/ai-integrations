import { z } from "zod";
import calcs from "@aclymatepackages/calcs/myAclymate/index.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope
} from "../../../responseEnvelope.js";
import {
  FACTOR_SNAPSHOT,
  deriveConfidence,
  isValidCalcResult
} from "./factorSnapshot.js";

const { petsCarbon } = calcs;

const SOURCES = [
  {
    name: "Aclymate MyAclymate pet emissions factors",
    vintage: "2024"
  }
];

const inputShape = {
  numDogs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Number of dogs. Defaults to 0."),
  numCats: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Number of cats. Defaults to 0."),
  numLargeDogs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Number of large dogs (counted separately at 2× dog factor). Defaults to 0.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_pet_emissions",
  title: "Calculate Pet Emissions",
  description:
    "Calculate monthly and annual tCO2e for pets — dogs, cats, and large dogs (counted at 2× the standard dog factor). All counts default to 0. An all-zero request returns an all-zero result without warning (a valid answer)."
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

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { numDogs, numCats, numLargeDogs } = parsed.data;

  const breakdown = petsCarbon({ numDogs, numCats, numLargeDogs });
  const {
    monthlyDogsTonsCo2e,
    monthlyCatsTonsCo2e,
    monthlyLargeDogsTonsCo2e
  } = breakdown;

  const monthlyTotal =
    monthlyDogsTonsCo2e + monthlyCatsTonsCo2e + monthlyLargeDogsTonsCo2e;

  if (!isValidCalcResult(monthlyTotal)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Pet calc returned unexpected value: ${monthlyTotal}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      monthly_tco2e: monthlyTotal,
      annual_tco2e: monthlyTotal * 12,
      breakdown: {
        monthly_dogs_tco2e: monthlyDogsTonsCo2e,
        monthly_cats_tco2e: monthlyCatsTonsCo2e,
        monthly_large_dogs_tco2e: monthlyLargeDogsTonsCo2e
      }
    },
    sources: SOURCES,
    confidence: deriveConfidence({}),
    warnings: [],
    factorSnapshot: FACTOR_SNAPSHOT,
    methodologyUrl: null,
    viewInAclymateUrl: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
