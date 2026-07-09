import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  definition as lookupDef,
  handler as lookupFactorById
} from "../src/tools/browse/lookupFactorById.js";
import {
  definition as findDef,
  handler as findFactor
} from "../src/tools/browse/findFactor.js";
import {
  definition as searchDef,
  handler as searchFactors
} from "../src/tools/browse/searchFactors.js";
import {
  definition as listTypesDef,
  handler as listFactorTypes
} from "../src/tools/browse/listFactorTypes.js";
import {
  definition as listKeyValuesDef,
  handler as listFactorKeyValues
} from "../src/tools/browse/listFactorKeyValues.js";

const assertSuccessEnvelope = (env) => {
  assert.equal(
    env.error,
    null,
    `expected error===null, got ${JSON.stringify(env.error)}`
  );
  assert.equal(env.attribution.name, "Aclymate");
  assert.ok(env.factor_snapshot);
  assert.equal(
    env.factor_snapshot.package,
    "@aclymatepackages/emissions-factors"
  );
  assert.ok(env.factor_snapshot.version, "factor_snapshot.version must be set");
  assert.ok(Array.isArray(env.warnings));
  assert.equal(env.upgrade_hint, null);
};

const assertErrorEnvelope = (env, expectedCode) => {
  assert.ok(env.error, `expected error, got null`);
  assert.equal(env.error.code, expectedCode);
  assert.equal(env.result, null);
};

// list_factor_types

test("list_factor_types — returns non-empty list of factor types", async () => {
  const env = await listFactorTypes({});
  assertSuccessEnvelope(env);
  assert.ok(Array.isArray(env.result.factor_types));
  assert.ok(env.result.factor_types.length > 20);
  assert.ok(env.result.factor_types.includes("egrid"));
  assert.equal(env.warnings.length, 0);
  assert.equal(env.confidence, "high");
});

// lookup_factor_by_id

test("lookup_factor_by_id — canonical hit returns matching factor", async () => {
  const env = await lookupFactorById({ factor_id: "egrid-akgd-2019" });
  assertSuccessEnvelope(env);
  assert.equal(env.result.factor_id, "egrid-akgd-2019");
  assert.equal(env.result.factor_type, "egrid");
  assert.equal(env.confidence, "high");
  assert.equal(env.warnings.length, 0);
  assert.ok(env.sources.length > 0);
});

test("lookup_factor_by_id — unknown id returns null + FACTOR_NOT_FOUND", async () => {
  const env = await lookupFactorById({ factor_id: "does-not-exist" });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.equal(env.confidence, null);
  assert.ok(env.warnings.find((w) => w.code === "factor_not_found"));
});

test("lookup_factor_by_id — missing factor_id rejected as invalid_input", async () => {
  const env = await lookupFactorById({});
  assertErrorEnvelope(env, "invalid_input");
});

// find_factor

test("find_factor — exact match returns factor", async () => {
  const env = await findFactor({
    factor_type: "egrid",
    keys: { egrid_region: "AKGD", vintage_year: 2019 }
  });
  assertSuccessEnvelope(env);
  assert.ok(env.result);
  assert.equal(env.result.factor_type, "egrid");
  assert.equal(env.result.keys.egrid_region, "AKGD");
  assert.equal(env.confidence, "high");
});

test("find_factor — unknown factor_type returns null + UNKNOWN_FACTOR_TYPE", async () => {
  const env = await findFactor({
    factor_type: "invalid_type_xyz",
    keys: { foo: "bar" }
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.ok(env.warnings.find((w) => w.code === "unknown_factor_type"));
});

test("find_factor — empty keys returns null + NO_KEYS_SUPPLIED (fail-null)", async () => {
  const env = await findFactor({ factor_type: "egrid", keys: {} });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.ok(env.warnings.find((w) => w.code === "no_keys_supplied"));
});

test("find_factor — keys omitted returns null + NO_KEYS_SUPPLIED (fail-null)", async () => {
  const env = await findFactor({ factor_type: "egrid" });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.ok(env.warnings.find((w) => w.code === "no_keys_supplied"));
});

test("find_factor — unknown key name returns null + UNKNOWN_KEY_NAME", async () => {
  const env = await findFactor({
    factor_type: "egrid",
    keys: { region: "AKGD" }
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.ok(env.warnings.find((w) => w.code === "unknown_key_name"));
});

test("find_factor — valid keys with no match returns null + NO_MATCH_FOR_KEYS", async () => {
  const env = await findFactor({
    factor_type: "egrid",
    keys: { egrid_region: "ZZZZZ", vintage_year: 2019 }
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result, null);
  assert.ok(env.warnings.find((w) => w.code === "no_match_for_keys"));
});

// search_factors

test("search_factors — matches on alias returns factors", async () => {
  const env = await searchFactors({ query: "AKGD" });
  assertSuccessEnvelope(env);
  assert.ok(Array.isArray(env.result.factors));
  assert.ok(env.result.factors.length > 0);
  assert.ok(env.result.count >= env.result.factors.length);
});

test("search_factors — zero results returns empty list + NO_SEARCH_MATCHES", async () => {
  const env = await searchFactors({ query: "definitely_not_a_real_factor_zzzz" });
  assertSuccessEnvelope(env);
  assert.deepEqual(env.result, { factors: [], count: 0 });
  assert.ok(env.warnings.find((w) => w.code === "no_search_matches"));
});

test("search_factors — unknown factor_type filter returns empty + UNKNOWN_FACTOR_TYPE", async () => {
  const env = await searchFactors({
    query: "anything",
    factor_type: "invalid_xyz"
  });
  assertSuccessEnvelope(env);
  assert.deepEqual(env.result, { factors: [], count: 0 });
  assert.ok(env.warnings.find((w) => w.code === "unknown_factor_type"));
});

test("search_factors — completes fast against heavy ceda_sector type", async () => {
  const t0 = process.hrtime.bigint();
  const env = await searchFactors({ query: "electricity", factor_type: "ceda_sector" });
  const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assertSuccessEnvelope(env);
  assert.ok(
    elapsed_ms < 2000,
    `search_factors on ceda_sector took ${elapsed_ms.toFixed(0)}ms (expected < 2000)`
  );
});

test("search_factors — missing query rejected as invalid_input", async () => {
  const env = await searchFactors({});
  assertErrorEnvelope(env, "invalid_input");
});

// list_factor_key_values

test("list_factor_key_values — explicit key returns values + no warning", async () => {
  const env = await listFactorKeyValues({
    factor_type: "egrid",
    key_name: "egrid_region"
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result.factor_type, "egrid");
  assert.equal(env.result.key_name, "egrid_region");
  assert.ok(env.result.values.length > 0);
  assert.equal(env.warnings.length, 0);
});

test("list_factor_key_values — omitted key_name uses drill key + DRILL_KEY_DEFAULTED warning", async () => {
  const env = await listFactorKeyValues({ factor_type: "egrid" });
  assertSuccessEnvelope(env);
  assert.equal(env.result.factor_type, "egrid");
  assert.equal(env.result.key_name, "egrid_region");
  assert.ok(env.result.values.length > 0);
  assert.ok(env.warnings.find((w) => w.code === "drill_key_defaulted"));
});

test("list_factor_key_values — unknown factor_type returns empty + UNKNOWN_FACTOR_TYPE", async () => {
  const env = await listFactorKeyValues({ factor_type: "invalid_xyz" });
  assertSuccessEnvelope(env);
  assert.deepEqual(env.result, {
    factor_type: "invalid_xyz",
    key_name: null,
    values: []
  });
  assert.ok(env.warnings.find((w) => w.code === "unknown_factor_type"));
});

test("list_factor_key_values — key_name not on any factor returns empty values (no error)", async () => {
  const env = await listFactorKeyValues({
    factor_type: "egrid",
    key_name: "not_a_real_key"
  });
  assertSuccessEnvelope(env);
  assert.equal(env.result.factor_type, "egrid");
  assert.equal(env.result.key_name, "not_a_real_key");
  assert.deepEqual(env.result.values, []);
});

// regression fixture — catches alias-index drift on emissions-factors bumps

test("search_factors — canonical-queries fixture returns expected top factor_id prefixes", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(__dirname, "fixtures/search-canonical-queries.json");
  const { queries } = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const { query, expected_top_factor_id_prefix } of queries) {
    const env = await searchFactors({ query });
    assert.equal(env.error, null, `query '${query}': unexpected error`);
    assert.ok(
      env.result.factors.length > 0,
      `query '${query}': expected non-empty results`
    );
    const topId = env.result.factors[0].factor_id;
    assert.ok(
      topId.startsWith(expected_top_factor_id_prefix),
      `query '${query}': expected top factor_id to start with '${expected_top_factor_id_prefix}', got '${topId}'`
    );
  }
});

// meta

test("all 5 definitions expose {name, title, description}", () => {
  const defs = [lookupDef, findDef, searchDef, listTypesDef, listKeyValuesDef];
  for (const def of defs) {
    assert.ok(def.name);
    assert.ok(def.title);
    assert.ok(def.description);
  }
});
