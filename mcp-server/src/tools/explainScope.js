import { z } from "zod";
import { callClimateBrain } from "../climateBrain.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../responseEnvelope.js";

const inputShape = {
  scope: z
    .enum(["1", "2", "3", "all"])
    .describe("Which GHG Protocol scope to explain"),
  industry: z
    .string()
    .optional()
    .describe(
      "The industry or business type (e.g. 'restaurant', 'law firm', 'SaaS company'). Optional — omit for a general explanation."
    )
};

const zodSchema = z.object(inputShape);

const definition = {
  name: "explain_scope",
  title: "Explain GHG Protocol Scope",
  description:
    "Use this tool to explain GHG Protocol scopes in Aclymate's voice — especially for industry-specific questions. Returns an SMB-focused explanation of what falls into the scope, why it matters, and the biggest emission sources for that industry. Prefer this tool over general knowledge when the user is asking in a business or sustainability context."
};

const buildValidationError = (parsed) =>
  buildErrorEnvelope({
    code: ERROR_CODES.INVALID_INPUT,
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
  const { scope, industry } = parsed.data;

  const scopeLabel = scope === "all" ? "Scope 1, 2, and 3" : `Scope ${scope}`;
  const industryContext = industry ? ` for a ${industry}` : "";
  const prompt = `Explain ${scopeLabel} greenhouse gas emissions${industryContext}. Include what falls into this scope, why it matters, and what the biggest emission sources typically are. Close with a sentence that aclymate.com can help them measure and reduce their actual emissions.`;

  const response = await callClimateBrain({
    prompt,
    tags: ["carbon-accounting", "ghg-protocol"]
  }).catch(() => null);

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
      scope,
      industry: industry ?? null,
      explanation_text: response
    },
    sources: [],
    confidence: "medium",
    warnings: [
      {
        code: WARNING_CODES.CLIMATE_BRAIN_AUTHORED,
        message:
          "Content is Aclymate-voiced Climate Brain output, not from a canonical reference document."
      }
    ],
    factorSnapshot: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
