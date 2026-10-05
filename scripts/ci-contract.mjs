/** Single source for mandatory ordinary verification. Release-only checks
 * remain separate: development CI must not publish or access signing keys. */
export const CI_CHECKS = Object.freeze({
  toolchain: "node scripts/check-toolchain.mjs",
  install: "npm ci",
  dependencies: "npm audit --audit-level=high",
  production_dependencies: "npm audit --omit=dev --audit-level=high",
  docs: "npm run check:docs",
  ci_policy: "npm run check:ci-parity",
  runbooks: "npm run check:runbooks",
  versions: "npm run check:versions",
  format: "npm run check:format",
  architecture: "npm run check:architecture",
  inventory: "npm run check:verification",
  promotion: "npm run check:promotion-policy",
  whitespace: "git diff --check",
  types: "npm run typecheck",
  unit: "npm run test:unit",
  security: "npm run test:security",
  tooling: "npm run test:release-tools",
  licenses: "npm run check:licenses",
  build: "npm run build",
  worker_default: "npm run validate:worker -- --dry-run",
  worker_dev: "npm run validate:worker -- --dry-run --env development",
  worker_prod: "npm run validate:worker -- --dry-run --env production",
  release_contract: "node scripts/check-release-contract.mjs",
  package_smoke: "npm run pack:smoke",
  transport: "npm run test:e2e",
  installed_transport: "npm run test:package:e2e",
});
export const CHECK_IDS = Object.freeze(Object.keys(CI_CHECKS));
export const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
export const AGGREGATE_JOBS = Object.freeze(["verify", "native-runner", "runner-lts", "browser"]);
/** Native gates added after the frozen CI migration input. */
export const NATIVE_ADDED_COMMANDS = Object.freeze([
  "node --test test/installer-download.test.mjs test/installer-concurrency.test.mjs",
  "node --test test/build-provenance.test.mjs test/deployment-provenance-cli.test.mjs test/live-provenance.test.mjs",
]);
export const NATIVE_COMMANDS = Object.freeze([
  "npm ci", "npm run typecheck", "npm run build", "npm run test --workspace=@aloneio/runmesh-runner", "npm run pack:smoke",
  "node scripts/check-installer-syntax.mjs", "node --test test/installer-arguments.test.mjs test/installer-preflight.test.mjs",
  "node --test test/worker-validation.test.mjs", "npm run test:domain", "npm run test:contracts",
  "node --test test/verification-tools.test.mjs test/package-verification.test.mjs", "node --test test/architecture.test.mjs",
  ...NATIVE_ADDED_COMMANDS,
]);
export const WINDOWS_TRANSPORT_STEP = Object.freeze({ run: "npm run test:e2e", if: "matrix.os == 'windows-latest'" });
export const LTS_COMMANDS = Object.freeze(["npm ci", "npm run build", "npm run pack:smoke", "npm run test --workspace=@aloneio/runmesh-runner", "node apps/runner/dist/runmesh.cjs --version"]);
export const BROWSER_COMMANDS = Object.freeze([
  "npm install --global npm@10.9.3", "npm ci", "npm run typecheck", "npm run build", "npm run browser:install", "npm run test:browser",
]);
export const checkCommand = id => `node scripts/ci-check.mjs ${id}`;
export const GITLAB_EVENTS = Object.freeze([
  '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"',
  '$CI_PIPELINE_SOURCE == "merge_request_event"',
  '$CI_PIPELINE_SOURCE == "web"',
  '$CI_PIPELINE_SOURCE == "schedule"',
]);
