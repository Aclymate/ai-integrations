import { z } from "zod";

// The MCP SDK validates each tool's registered inputShape itself, before the tool's
// own handler — and therefore before withAudit/withMetering/withTierGate/withRateLimit
// — ever runs (see McpServer.validateToolInput in the SDK). A call that fails that
// check returns a raw, un-enveloped JSON-RPC -32602 error and never reaches the audit
// log or any rate limit/metering counter — invisible to the whole system built to
// track Tier-3 usage. Every tool's handler already re-validates its own strict
// inputShape internally (via zodSchema.safeParse) and returns a properly-enveloped,
// audited error on failure. This loosens only the one construct that's both common
// and safe to rebuild generically — z.enum(...), including through .optional()/
// .default()/.nullable() wrappers — to a plain z.string() for SDK registration only.
// The strict inputShape used inside each handler is untouched; a bad enum value now
// reaches the handler (which rejects it exactly as before) instead of being dropped
// pre-audit. Other constraints (.min()/.max()/refinements) aren't touched — zod v4
// stores those as opaque check functions with no public API to strip generically,
// and guessing at zod's internals here risks silently breaking schemas across every
// tool at once for marginal benefit.
const findDescription = (field) => {
  if (!field) {
    return undefined;
  }
  if (field.description) {
    return field.description;
  }
  return findDescription(field?._def?.innerType);
};

const loosenField = (field) => {
  const type = field?._def?.type;
  if (type === "enum") {
    return z.string();
  }
  if (type === "optional") {
    return loosenField(field._def.innerType).optional();
  }
  if (type === "nullable") {
    return loosenField(field._def.innerType).nullable();
  }
  if (type === "default") {
    return loosenField(field._def.innerType).default(field._def.defaultValue);
  }
  return field;
};

const loosenSchemaForRegistration = (shape) =>
  Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      const loosened = loosenField(field);
      const description = findDescription(field);
      return [
        key,
        description && loosened !== field ? loosened.describe(description) : loosened
      ];
    })
  );

export { loosenSchemaForRegistration };
