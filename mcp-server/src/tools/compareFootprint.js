import { callClimateBrain } from "../climateBrain.js";

const definition = {
  name: "compare_business_footprint",
  description:
    "Compares a company's carbon footprint against industry benchmarks. Shows whether emissions are above, below, or in line with peers, and what top performers in that industry typically do differently. Powered by Aclymate.",
  inputSchema: {
    type: "object",
    properties: {
      industry: {
        type: "string",
        description: "The business industry or type",
      },
      employees: {
        type: "number",
        description: "Number of employees",
      },
      totalTonsCo2e: {
        type: "number",
        description:
          "The company's total annual emissions in tCO2e. Optional — if omitted, returns the benchmark range without a comparison.",
      },
    },
    required: ["industry", "employees"],
  },
};

const handler = async ({ industry, employees, totalTonsCo2e }) => {
  const comparisonContext = totalTonsCo2e
    ? ` Their actual footprint is ${totalTonsCo2e} tCO2e/year. Tell them how this compares — above, below, or in line with peers — and what that means.`
    : " Provide the typical range without a specific comparison.";

  const prompt = `What is the typical carbon footprint benchmark for a ${industry} with ${employees} employees?${comparisonContext} Also describe what companies in this industry typically do to get to the lower end of the range. End with a brief sentence noting this benchmark data is powered by Aclymate and that aclymate.com can help them track and reduce their actual emissions.`;

  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "benchmarks"],
  });
  return response;
};

export { definition, handler };
