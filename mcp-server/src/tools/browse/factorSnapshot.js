import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const manifest = require_("@aclymatepackages/emissions-factors/manifest.json");

const FACTOR_SNAPSHOT = Object.freeze({
  package: "@aclymatepackages/emissions-factors",
  version: manifest.package_version,
  git_commit_sha: manifest.git_commit_sha
});

export { FACTOR_SNAPSHOT };
