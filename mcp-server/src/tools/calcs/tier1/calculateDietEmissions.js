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

const { monthlyDietTypeCarbon } = calcs;

const SOURCES = [
  {
    name: "Aclymate MyAclymate diet emissions factors",
    vintage: "2024"
  }
];

const inputShape = {
  dietType: z
    .enum(["sad", "had-1", "had-2", "had-3"])
    .describe(
      "Diet type. sad = Standard American Diet; had-1/had-2/had-3 = Healthy American Diet tiers 1 (least meat reduction) → 3 (most meat reduction)."
    ),
  numPeople: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe("Number of people on this diet. Defaults to 1.")
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "calculate_diet_emissions",
  title: "Calculate Diet Emissions",
  description:
    "Calculate monthly and annual tCO2e for a diet type across N people. `dietType`: `sad` (Standard American Diet), `had-1`, `had-2`, `had-3` (Healthy American Diet tiers — 3 is the most plant-forward). `numPeople` defaults to 1. Unknown diet types are rejected."
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
  const { dietType, numPeople } = parsed.data;

  const monthlyTonsCo2e = monthlyDietTypeCarbon(dietType, numPeople);

  if (!isValidCalcResult(monthlyTonsCo2e)) {
    return buildErrorEnvelope({
      code: "calc_unexpected_output",
      http_status: 500,
      message: `Diet calc returned unexpected value: ${monthlyTonsCo2e}`,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      monthly_tco2e: monthlyTonsCo2e,
      annual_tco2e: monthlyTonsCo2e * 12,
      diet_type: dietType,
      num_people: numPeople
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
