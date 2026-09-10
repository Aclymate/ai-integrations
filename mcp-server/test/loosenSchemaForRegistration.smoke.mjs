// Zero-infra smoke tests for loosenSchemaForRegistration.js. Run:
// `node test/loosenSchemaForRegistration.smoke.mjs`.
//
// Why this exists: the MCP SDK validates a tool's registered inputShape itself,
// before the handler (and therefore before withAudit/withMetering/withTierGate/
// withRateLimit) ever runs. A z.enum(...) rejection there is a raw, un-enveloped
// JSON-RPC error, invisible to the whole audit/metering system. This module
// loosens z.enum(...) fields (including through .optional()/.default()/
// .nullable()) to plain strings for SDK registration only, so a bad enum value
// reaches the handler — which still rejects it, via its own unmodified strict
// schema, through the normal enveloped + audited path — instead of being
// dropped pre-audit.

import assert from "node:assert/strict";
import { z } from "zod";

const { loosenSchemaForRegistration } = await import(
  "../src/loosenSchemaForRegistration.js"
);

const pending = [];
let currentGroup = "";

const describe = (name, fn) => {
  currentGroup = name;
  fn();
};

const test = (name, fn) => {
  pending.push({ label: `${currentGroup} › ${name}`, fn });
};

describe("loosenSchemaForRegistration — enum loosening", () => {
  test("bare enum becomes a plain string", () => {
    const loosened = loosenSchemaForRegistration({
      dietType: z.enum(["sad", "had-1"])
    });
    assert.equal(loosened.dietType._def.type, "string");
    // the whole point: a value outside the original enum now parses cleanly here
    const result = loosened.dietType.safeParse("not-a-real-diet");
    assert.equal(result.success, true);
  });

  test("optional-wrapped enum stays optional after loosening", () => {
    const loosened = loosenSchemaForRegistration({
      fuelType: z.enum(["naturalGas", "propane"]).optional()
    });
    assert.equal(loosened.fuelType._def.type, "optional");
    assert.equal(loosened.fuelType._def.innerType._def.type, "string");
    assert.equal(loosened.fuelType.safeParse(undefined).success, true);
    assert.equal(loosened.fuelType.safeParse("anything").success, true);
  });

  test("default-wrapped enum stays defaulted, with the same default value", () => {
    const loosened = loosenSchemaForRegistration({
      unit: z.enum(["kwh", "mwh"]).default("kwh")
    });
    assert.equal(loosened.unit._def.type, "default");
    assert.equal(loosened.unit._def.defaultValue, "kwh");
    assert.equal(loosened.unit.parse(undefined), "kwh");
    assert.equal(loosened.unit.parse("anything"), "anything");
  });

  test("description on the bare enum is preserved", () => {
    const loosened = loosenSchemaForRegistration({
      dietType: z.enum(["sad", "had-1"]).describe("A diet type.")
    });
    assert.equal(loosened.dietType.description, "A diet type.");
  });

  test("description on the optional wrapper (not the inner enum) is preserved", () => {
    const loosened = loosenSchemaForRegistration({
      fuelType: z.enum(["naturalGas", "propane"]).optional().describe("Fuel type.")
    });
    assert.equal(loosened.fuelType.description, "Fuel type.");
  });

  test("description on the inner enum (wrapper undescribed) is preserved", () => {
    const loosened = loosenSchemaForRegistration({
      fuelType: z.enum(["naturalGas", "propane"]).describe("Fuel type.").optional()
    });
    assert.equal(loosened.fuelType.description, "Fuel type.");
  });

  test("a truly bare (unwrapped) non-enum field passes through by reference", () => {
    const original = z.number().int().positive();
    const loosened = loosenSchemaForRegistration({ count: original });
    assert.equal(loosened.count, original);
  });

  // .optional()/.default()/.nullable() wrappers are always rebuilt (cheaply — they
  // just recurse one level to check for a nested enum), even around a non-enum inner
  // type. Not reference-equal, but must parse identically to the original.
  test("a wrapped non-enum field is rebuilt but behaves identically to the original", () => {
    const original = z.number().int().positive().default(1);
    const loosened = loosenSchemaForRegistration({ numPeople: original }).numPeople;
    assert.notEqual(loosened, original);
    assert.equal(loosened.parse(undefined), original.parse(undefined));
    assert.equal(loosened.parse(5), original.parse(5));
    assert.equal(loosened.safeParse(-1).success, original.safeParse(-1).success);
  });

  test("non-enum optional fields still parse identically after rebuilding", () => {
    const loosened = loosenSchemaForRegistration({
      note: z.string().optional().describe("Freeform note.")
    });
    assert.equal(loosened.note.description, "Freeform note.");
    assert.equal(loosened.note.safeParse(undefined).success, true);
    assert.equal(loosened.note.safeParse("hi").success, true);
    assert.equal(loosened.note.safeParse(42).success, false);
  });

  test("mixed shape: only the enum field's behavior changes, the other field parses identically", () => {
    const original = {
      dietType: z.enum(["sad", "had-1"]),
      numPeople: z.number().int().positive().default(1)
    };
    const loosened = loosenSchemaForRegistration(original);
    assert.equal(loosened.numPeople.parse(undefined), original.numPeople.parse(undefined));
    assert.equal(loosened.numPeople.parse(3), original.numPeople.parse(3));
    assert.notEqual(loosened.dietType, original.dietType);
    assert.equal(loosened.dietType.safeParse("not-a-real-diet").success, true);
    assert.equal(original.dietType.safeParse("not-a-real-diet").success, false);
  });
});

describe("loosenSchemaForRegistration — real tool shapes", () => {
  test("calculate_diet_emissions: loosened schema accepts a bogus dietType the original rejects", async () => {
    const { inputShape } = await import(
      "../src/tools/calcs/tier1/calculateDietEmissions.js"
    );
    const original = z.object(inputShape);
    const loosened = z.object(loosenSchemaForRegistration(inputShape));

    assert.equal(
      original.safeParse({ dietType: "keto" }).success,
      false,
      "original strict schema still rejects a bad dietType"
    );
    assert.equal(
      loosened.safeParse({ dietType: "keto" }).success,
      true,
      "loosened schema lets it through — the handler's own strict check now runs instead"
    );
  });

  test("calculate_diet_emissions: a genuinely valid call still parses identically both ways", async () => {
    const { inputShape } = await import(
      "../src/tools/calcs/tier1/calculateDietEmissions.js"
    );
    const original = z.object(inputShape);
    const loosened = z.object(loosenSchemaForRegistration(inputShape));
    const validInput = { dietType: "had-2", numPeople: 3 };

    assert.equal(original.safeParse(validInput).success, true);
    assert.equal(loosened.safeParse(validInput).success, true);
  });

  test("known residual gap: enums nested inside a union/array (calculate_office_utility_emissions) are NOT reached", async () => {
    const { inputShape } = await import(
      "../src/tools/tier2/calculateOfficeUtilityEmissions.js"
    );
    const loosened = z.object(loosenSchemaForRegistration(inputShape));
    // A bad `unit` inside the utilities array is still caught at registration time —
    // documented, not fixed, in loosenSchemaForRegistration.js's own comment.
    const badInput = {
      utilities: [{ type: "gas", quantity: 10, unit: "not-a-real-unit" }]
    };
    assert.equal(loosened.safeParse(badInput).success, false);
  });
});

const results = [];
for (const { label, fn } of pending) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, err });
  }
}
const failed = results.filter((r) => !r.ok);
results.forEach((r) => {
  const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${icon} ${r.label}`);
  if (!r.ok) {
    console.log(`    ${r.err?.stack || r.err}`);
  }
});
console.log(
  `\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ""}`
);
process.exit(failed.length ? 1 : 0);
