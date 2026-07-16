#!/usr/bin/env node
// Enforces cross-engine parity between three surfaces:
//   1. Registered MCP tools — collected from `src/tools/**` via dynamic import
//   2. OpenAPI operations in `../openai/gpt-actions.yaml`
//   3. Claude desktop-extension manifest `../claude/desktop-extension/manifest.json`
//
// Fails (exit 1) if any tool is missing from any surface. Per FM §6 every
// Tier-1 / Tier-2 / Tier-3 tool must land on all three surfaces together.

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOOLS_ROOT = resolve(__dirname, "../src/tools");
const GPT_ACTIONS_PATH = resolve(__dirname, "../../openai/gpt-actions.yaml");
const MANIFEST_PATH = resolve(
  __dirname,
  "../../claude/desktop-extension/manifest.json"
);

// Manually maintained: OpenAPI paths use kebab-case; tool names use snake_case.
// If you add a new tool, add its route here — otherwise the OpenAPI presence
// check silently skips it. Long-term: derive from server.js:restRouteHandlers.
const REST_PATH_TO_TOOL_NAME = {
  "/estimate-emissions": "estimate_emissions",
  "/explain-scope": "explain_scope",
  "/get-emission-factor": "get_emission_factor",
  "/compare-footprint": "compare_business_footprint",
  "/lookup-factor-by-id": "lookup_factor_by_id",
  "/find-factor": "find_factor",
  "/search-factors": "search_factors",
  "/list-factor-types": "list_factor_types",
  "/list-factor-key-values": "list_factor_key_values",
  "/calculate-flight-emissions": "calculate_flight_emissions",
  "/calculate-train-emissions": "calculate_train_emissions",
  "/calculate-other-transport-emissions": "calculate_other_transport_emissions",
  "/calculate-electricity-emissions": "calculate_electricity_emissions",
  "/calculate-gas-emissions": "calculate_gas_emissions",
  "/calculate-diet-emissions": "calculate_diet_emissions",
  "/calculate-pet-emissions": "calculate_pet_emissions",
  "/recommend-emissions-reductions": "recommend_emissions_reductions"
};

const collectToolFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        return collectToolFiles(full);
      }
      if (entry.name.endsWith(".js")) {
        return [full];
      }
      return [];
    })
  );
  return children.flat();
};

const extractToolFileNames = async () => {
  const files = await collectToolFiles(TOOLS_ROOT);
  const names = await Promise.all(
    files.map(async (file) => {
      const mod = await import(pathToFileURL(file).href);
      return mod?.definition?.name;
    })
  );
  return new Set(names.filter(Boolean));
};

const extractOpenApiPaths = async () => {
  const src = await readFile(GPT_ACTIONS_PATH, "utf8");
  const pathMatches = Array.from(src.matchAll(/^  (\/[a-z0-9\-_/]+):/gm)).map(
    (m) => m[1]
  );
  return new Set(
    pathMatches.map((p) => REST_PATH_TO_TOOL_NAME[p]).filter(Boolean)
  );
};

const extractManifestTools = async () => {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  return new Set((manifest.tools || []).map((t) => t.name));
};

const main = async () => {
  const [toolFileNames, openApiTools, manifestTools] = await Promise.all([
    extractToolFileNames(),
    extractOpenApiPaths(),
    extractManifestTools()
  ]);

  const union = new Set([
    ...toolFileNames,
    ...openApiTools,
    ...manifestTools
  ]);

  const gaps = [...union]
    .map((tool) => {
      const surfaces = {
        toolFile: toolFileNames.has(tool),
        openApi: openApiTools.has(tool),
        manifest: manifestTools.has(tool)
      };
      const missing = Object.entries(surfaces)
        .filter(([, present]) => !present)
        .map(([surface]) => surface);
      return missing.length ? { tool, missing } : null;
    })
    .filter(Boolean);

  if (!gaps.length) {
    process.stdout.write(
      `check-tool-parity: OK — ${union.size} tools present on all 3 surfaces\n`
    );
    process.exit(0);
  }

  process.stderr.write("check-tool-parity: MISMATCHES\n");
  for (const { tool, missing } of gaps) {
    process.stderr.write(`  ${tool}: missing from ${missing.join(", ")}\n`);
  }
  process.exit(1);
};

main().catch((err) => {
  process.stderr.write(`check-tool-parity: ${err.stack || err.message}\n`);
  process.exit(1);
});
