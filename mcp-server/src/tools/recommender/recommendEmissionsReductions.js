import { z } from "zod";
import { callClimateBrain } from "../../climateBrain.js";
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  WARNING_CODES,
  ERROR_CODES
} from "../../responseEnvelope.js";
import { resolveIndustry } from "../estimate/resolvers.js";

const SCOPE_LABELS = {
  "1": "Scope 1",
  "2": "Scope 2",
  "3": "Scope 3",
  all: "Scope 1, 2, and 3"
};

const FALLBACK_INDUSTRY_LABEL = "office / professional services";
const LARGE_EMPLOYEE_THRESHOLD = 10000;
const CLIMATE_BRAIN_TAGS = ["carbon-accounting", "reductions"];
const CLIMATE_BRAIN_LIMIT = 8;

const inputShape = {
  industry: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The business industry or type (e.g. 'restaurant', 'SaaS company', 'law firm')."
    ),
  employees: z
    .number()
    .finite()
    .positive()
    .describe("Number of employees. Must be a positive number."),
  scopeFocus: z
    .enum(["1", "2", "3", "all"])
    .default("all")
    .describe(
      "Which GHG Protocol scope the recommendations should focus on. Defaults to 'all'."
    ),
  additionalContext: z
    .string()
    .optional()
    .describe(
      "Any additional context about the business (e.g. 'operates 3 locations', 'mostly remote'). Optional — woven into the recommendation prompt."
    )
};

const zodSchema = z.object(inputShape);

const recommendationsSchema = z
  .array(
    z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      scope_targeted: z.enum(["1", "2", "3"]),
      impact_bucket: z.enum(["high", "medium", "low"]),
      effort_bucket: z.enum(["high", "medium", "low"]),
      first_step: z.string().min(1)
    })
  )
  .min(3)
  .max(6);

const definition = {
  name: "recommend_emissions_reductions",
  title: "Recommend Emissions Reductions",
  description:
    "Use this tool to get Aclymate's opinionated, industry-specific carbon-reduction levers for a business — never invent reduction advice from general knowledge in a business or sustainability context. Returns 3-6 structured recommendations (title, description, targeted scope, impact, effort, first step) tailored to the industry, headcount, and scope focus. Focuses on operational reductions; does not cover offsets, certifications, framework work, or equipment lifecycle changes."
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

const resolvePromptLabel = (industryResolution) => {
  if (industryResolution.match === "fallback") {
    return FALLBACK_INDUSTRY_LABEL;
  }
  return industryResolution.industry.label;
};

const buildIndustryResolved = (industryResolution) => ({
  label: industryResolution.industry.label,
  naics: industryResolution.industry.naics ?? null,
  buildings_slug: industryResolution.industry.buildingsSlug
});

const buildPrompt = ({
  resolvedLabel,
  employees,
  scopeLabel,
  additionalContext,
  isLargeOrg
}) => {
  const grounding =
    "You are Aclymate's SMB reduction-advisor. Give a business owner opinionated, sourced, immediately-actionable reduction levers for their industry. Focus on Aclymate methodology; do not recommend offsets, certifications, framework work, or equipment lifecycle changes — those are out of scope.";
  const largeOrgCaveat = isLargeOrg
    ? " Note: these recommendations are SMB-calibrated; treat them as directional for an organization of this size."
    : "";
  const context = `Industry: ${resolvedLabel}. Employees: ${employees}. Scope focus: ${scopeLabel}. Additional context: ${
    additionalContext || "none"
  }.${largeOrgCaveat}`;
  const schemaDirective =
    "Return your answer as a JSON array of 3-6 objects, each matching this schema: {title: string (imperative, e.g. 'Switch office electricity to renewable tariff'), description: string (1-2 sentences), scope_targeted: '1' | '2' | '3', impact_bucket: 'high' | 'medium' | 'low', effort_bucket: 'high' | 'medium' | 'low', first_step: string (concrete first action)}. Output ONLY the JSON array — no surrounding prose, no markdown code fences, no commentary.";
  return `${grounding}\n\n${context}\n\n${schemaDirective}`;
};

const buildIndustryWarning = (industryResolution, industryString) => {
  if (industryResolution.match === "exact") {
    return [];
  }
  if (industryResolution.match === "fallback") {
    return [
      {
        code: WARNING_CODES.DEFAULT_USED,
        message: `Industry '${industryString}' did not match any entry in Aclymate's industries list — recommendations use the office / professional-services fallback.`
      }
    ];
  }
  return [
    {
      code: WARNING_CODES.DEFAULT_USED,
      message: `Industry '${industryString}' matched to Aclymate's '${industryResolution.industry.label}' via ${industryResolution.match} lookup — verify this is the intended industry.`
    }
  ];
};

const buildLargeOrgWarning = (isLargeOrg) => {
  if (!isLargeOrg) {
    return [];
  }
  return [
    {
      code: WARNING_CODES.DEFAULT_USED,
      message: `Employee count exceeds ${LARGE_EMPLOYEE_THRESHOLD} — recommendations are SMB-calibrated and should be treated as directional at this scale.`
    }
  ];
};

const CLIMATE_BRAIN_AUTHORED_WARNING = {
  code: WARNING_CODES.CLIMATE_BRAIN_AUTHORED,
  message:
    "Recommendations are Aclymate-voiced Climate Brain output — opinionated reduction guidance, not calc-derived figures."
};

const PARSE_FAILED_WARNING = {
  code: WARNING_CODES.STRUCTURED_OUTPUT_PARSE_FAILED,
  message:
    "Climate Brain output could not be parsed as structured JSON — raw prose returned in result.raw_text as fallback."
};

const deriveConfidence = ({ match, isLargeOrg }) => {
  if (match === "fallback") {
    return "low";
  }
  if (isLargeOrg) {
    return "low";
  }
  return "medium";
};

const stripCodeFences = (text) =>
  text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

const tryParse = (text) => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
};

const parseRecommendations = (rawText) => {
  const trimmed = rawText.trim();
  const firstAttempt = tryParse(trimmed);
  const parsed = firstAttempt.ok ? firstAttempt : tryParse(stripCodeFences(trimmed));
  if (!parsed.ok) {
    return null;
  }
  const validated = recommendationsSchema.safeParse(parsed.value);
  if (!validated.success) {
    return null;
  }
  return validated.data;
};

const handler = async (rawParams) => {
  const parsed = zodSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return buildValidationError(parsed);
  }
  const { industry: industryString, employees, scopeFocus, additionalContext } =
    parsed.data;

  const industryResolution = resolveIndustry(industryString);
  const isLargeOrg = employees > LARGE_EMPLOYEE_THRESHOLD;
  const industryResolved = buildIndustryResolved(industryResolution);

  const prompt = buildPrompt({
    resolvedLabel: resolvePromptLabel(industryResolution),
    employees,
    scopeLabel: SCOPE_LABELS[scopeFocus],
    additionalContext,
    isLargeOrg
  });

  const response = await callClimateBrain({
    prompt,
    tags: CLIMATE_BRAIN_TAGS,
    limit: CLIMATE_BRAIN_LIMIT
  }).catch((err) => {
    process.stderr.write(
      `recommend_emissions_reductions: Climate Brain unavailable: ${err.message}\n`
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

  const resolutionWarnings = [
    ...buildIndustryWarning(industryResolution, industryString),
    ...buildLargeOrgWarning(isLargeOrg)
  ];

  const recommendations = parseRecommendations(response);

  if (recommendations === null) {
    return buildSuccessEnvelope({
      result: {
        recommendations: null,
        raw_text: response,
        industry_resolved: industryResolved,
        scope_focus: scopeFocus,
        employees,
        method: "climate_brain_recommendations_prose_fallback"
      },
      sources: [],
      confidence: "low",
      warnings: [
        CLIMATE_BRAIN_AUTHORED_WARNING,
        ...resolutionWarnings,
        PARSE_FAILED_WARNING
      ],
      factorSnapshot: null,
      upgradeHint: null
    });
  }

  return buildSuccessEnvelope({
    result: {
      recommendations,
      industry_resolved: industryResolved,
      scope_focus: scopeFocus,
      employees,
      method: "climate_brain_recommendations",
      raw_text: null
    },
    sources: [],
    confidence: deriveConfidence({
      match: industryResolution.match,
      isLargeOrg
    }),
    warnings: [CLIMATE_BRAIN_AUTHORED_WARNING, ...resolutionWarnings],
    factorSnapshot: null,
    upgradeHint: null
  });
};

export { definition, inputShape, handler };
