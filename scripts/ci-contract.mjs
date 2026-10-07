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
const REPORT_PATHS = Object.freeze(["ci-results/*.json", "ci-results/*.xml"]);
const REPORT_UPLOADS = Object.freeze({
  verify: { name: "ci-verify-${{ github.run_id }}-${{ github.run_attempt }}", condition: "always()" },
  browser: { name: "ci-browser-${{ github.run_id }}-${{ github.run_attempt }}", condition: "always()" },
  "native-runner": { name: "ci-native-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}", condition: "always() && matrix.os == 'windows-latest'" },
});
/** Only lanes that produce sanitized reports upload them, even after failure. */
export function githubReportUpload(job) {
  if (!Object.hasOwn(REPORT_UPLOADS, job)) throw new Error("unreviewed CI report upload lane");
  const rule = REPORT_UPLOADS[job];
  return { name: "Preserve sanitized gate evidence", if: rule.condition, uses: UPLOAD_ACTION, with: {
    name: rule.name, path: REPORT_PATHS.join("\n") + "\n", "if-no-files-found": "error", "retention-days": 14,
    "include-hidden-files": false, overwrite: false, archive: true,
  } };
}
export function gitlabReportArtifacts() {
  return { when: "always", expire_in: "14 days", paths: [...REPORT_PATHS], reports: { junit: "ci-results/*.xml" } };
}
export const AGGREGATE_JOBS = Object.freeze(["verify", "native-runner", "runner-lts", "browser"]);
/** Workflow validation and provider evidence share the same matrix identities. */
export const NATIVE_RUNNER_PLATFORMS = Object.freeze(["ubuntu-latest", "windows-latest", "macos-latest"]);
export const RUNNER_LTS_VERSIONS = Object.freeze(["22.23.2", "24.21.0"]);
export const GITHUB_JOB_NAMES = Object.freeze({
  verify: "verify", browser: "browser", "verify-all": "verify-all",
  "native-runner": "Runner native checks (${{ matrix.os }})",
  "runner-lts": "Runner LTS (${{ matrix.node }})",
});
export const REQUIRED_GITHUB_JOBS = Object.freeze([
  GITHUB_JOB_NAMES.verify, GITHUB_JOB_NAMES.browser, GITHUB_JOB_NAMES["verify-all"],
  ...NATIVE_RUNNER_PLATFORMS.map(os => GITHUB_JOB_NAMES["native-runner"].replace("${{ matrix.os }}", os)),
  ...RUNNER_LTS_VERSIONS.map(node => GITHUB_JOB_NAMES["runner-lts"].replace("${{ matrix.node }}", node)),
]);
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
export const WINDOWS_REPORT_INITIALIZATION_STEP = Object.freeze({ run: "node scripts/ci-check.mjs --initialize transport", if: WINDOWS_TRANSPORT_STEP.if });
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
