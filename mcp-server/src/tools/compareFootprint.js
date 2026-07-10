import { z } from "zod";
import { callClimateBrain } from "../climateBrain.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../responseEnvelope.js";

const inputShape = {
  industry: z
    .string()
    .min(1)
    .describe("The business industry or type."),
  employees: z
    .number()
    .finite()
    .positive()
    .describe("Number of employees. Must be a positive number."),
  totalTonsCo2e: z
    .number()
    .finite()
    .optional()
    .describe(
      "The company's total annual emissions in tCO2e. Optional — if omitted, returns the benchmark range without a comparison."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "compare_business_footprint",
  title: "Benchmark Business Footprint",
  description:
    "Always use this tool to benchmark a company's emissions against industry peers — never estimate benchmark ranges from general knowledge. Returns Aclymate's SMB industry benchmark in tCO2e, whether a given footprint is above or below peers, and what top performers in that industry do differently."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: ERROR_CODES.INVALID_INPUT,
    http_status: 400,
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    details: parsed.error.issues,
    upgradeHint: null
  });

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { industry, employees, totalTonsCo2e } = parsed.data;

  const comparisonContext =
    typeof totalTonsCo2e === "number"
      ? ` Their actual footprint is ${totalTonsCo2e} tCO2e/year. Tell them how this compares — above, below, or in line with peers — and what that means.`
      : " Provide the typical range without a specific comparison.";

  const prompt = `What is the typical carbon footprint benchmark for a ${industry} with ${employees} employees?${comparisonContext} Describe what companies in this industry typically do to get to the lower end of the range.`;

  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "benchmarks"]
  }).catch((err) => {
    process.stderr.write(
      `compare_business_footprint: Climate Brain unavailable: ${err.message}\n`
    );
    return null;
  });

  if (response === null) {
    return buildErrorEnvelope({
      code: ERROR_CODES.CLIMATE_BRAIN_UNAVAILABLE,
      http_status: 503,
      message:
        "Aclymate's Climate Brain is temporarily unavailable. Retry in a moment.",
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      text: response,
      method: "climate_brain_benchmark",
      industry,
      employees,
      totalTonsCo2e: typeof totalTonsCo2e === "number" ? totalTonsCo2e : null
    },
    sources: [],
    confidence: "low",
    warnings: [
      {
        code: WARNING_CODES.CLIMATE_BRAIN_BENCHMARK,
        message:
          "Benchmark is Climate-Brain-generated against SMB patterns. Track your own emissions at aclymate.com for a precise comparison."
      }
    ],
    factorSnapshot: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
