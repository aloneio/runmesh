import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reviewedReleaseSource, missingSecretNames, generateMissingSecrets, REQUIRED_SECRET_NAMES } from "../scripts/runtime-config-tools.mjs";
import { setupMissingSecrets } from "../scripts/setup-secrets.mjs";

test("release defaults require independent publication evidence and version alignment", () => {
  const state = { version: "1.2.3", state: "released", release_commit: "a".repeat(40), manifest_sha256: "b".repeat(64) };
  assert.match(reviewedReleaseSource("1.2.3", state), /REVIEWED_RELEASE_VERSION = "1.2.3"/);
  assert.match(reviewedReleaseSource("1.2.3", { version: "1.2.3", state: "candidate" }), /REVIEWED_RELEASE_VERSION = ""/);
  for (const invalid of [{ ...state, version: "1.2.4" }, { ...state, state: "unknown" }, { ...state, manifest_sha256: null }, { ...state, release_commit: "main" }]) assert.throws(() => reviewedReleaseSource("1.2.3", invalid));
});

test("only two required secrets; API administration is optional; existing values are never requested", () => {
  assert.deepEqual(REQUIRED_SECRET_NAMES, ["INTERNAL_CONTROL_SECRET", "RUNNER_TOKEN_PEPPER"]);
  assert.deepEqual(missingSecretNames([]), [...REQUIRED_SECRET_NAMES]);
  assert.deepEqual(missingSecretNames(REQUIRED_SECRET_NAMES.map(name => ({ name, type: "secret_text" }))), []);
  assert.deepEqual(missingSecretNames([{ name: "INTERNAL_CONTROL_SECRET" }, { name: "UNRELATED_CUSTOM_KEY" }]), ["RUNNER_TOKEN_PEPPER"]);
  assert.throws(() => missingSecretNames({ error: "access denied" }));
  assert.throws(() => missingSecretNames([{}, { name: "bad" }]));
  assert.throws(() => generateMissingSecrets(["ADMIN_TOKEN"]));
  const keys = generateMissingSecrets([...REQUIRED_SECRET_NAMES]);
  for (const value of Object.values(keys)) assert.match(value, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(keys.INTERNAL_CONTROL_SECRET, keys.RUNNER_TOKEN_PEPPER);
});

function fakeCloud(existing = []) {
  const names = new Set(existing); const requests = []; let uploaded;
  return { names, requests, get uploaded() { return uploaded; }, invoke(command, input) {
    requests.push(command);
    if (command[1] === "list") return { status: 0, stdout: JSON.stringify([...names].map(name => ({ name }))) };
    assert.equal(command[1], "bulk"); uploaded = JSON.parse(input);
    for (const name of Object.keys(uploaded)) names.add(name);
    return { status: 0, stdout: "" };
  } };
}

test("setup only plans by default and performs zero writes when required secrets already exist", () => {
  const empty = fakeCloud(); const report = setupMissingSecrets({ environment: "production", invoke: empty.invoke });
  assert.deepEqual(report.missing, [...REQUIRED_SECRET_NAMES]); assert.equal(empty.requests.length, 1);
  const ready = fakeCloud(REQUIRED_SECRET_NAMES);
  assert.deepEqual(setupMissingSecrets({ environment: "production", apply: true, invoke: ready.invoke }).created, []);
  assert.equal(ready.requests.length, 1);
});

test("setup creates only the missing secret; reports and argv contain no generated values", () => {
  const fake = fakeCloud(["RUNNER_TOKEN_PEPPER", "ADMIN_TOKEN"]);
  const report = setupMissingSecrets({ environment: "development", apply: true, invoke: fake.invoke });
  assert.deepEqual(Object.keys(fake.uploaded), ["INTERNAL_CONTROL_SECRET"]);
  assert.deepEqual(report.created, ["INTERNAL_CONTROL_SECRET"]);
  const visible = JSON.stringify([report, fake.requests]);
  assert.ok(!visible.includes(fake.uploaded.INTERNAL_CONTROL_SECRET));
});

test("failed inventory, concurrent changes and uncertain upload never trigger a retry", () => {
  assert.throws(() => setupMissingSecrets({ environment: "production", apply: true, invoke: () => ({ status: 1, stdout: "" }) }), /no secrets changed/);
  let read = 0;
  assert.throws(() => setupMissingSecrets({ environment: "production", apply: true, invoke: () => ({ status: 0, stdout: JSON.stringify(++read === 1 ? [] : [{ name: "INTERNAL_CONTROL_SECRET" }]) }) }), /inventory changed/);
  let uploads = 0;
  assert.throws(() => setupMissingSecrets({ environment: "production", apply: true, invoke: command => command[1] === "list" ? { status: 0, stdout: "[]" } : (++uploads, { status: 1, stdout: "unavailable" }) }), /outcome is uncertain/);
  assert.equal(uploads, 1);
});

test("normal production has no required plaintext vars; production namespace and key identities remain", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
  for (const env of [config, config.env.production]) {
    assert.deepEqual(env.vars, {});
    assert.deepEqual(env.durable_objects.bindings.map(b => b.class_name), ["RegistryDOv2", "RunnerDOv2"]);
    assert.equal(env.d1_databases[0].database_name, "runmesh-audit-history");
    assert.equal(env.version_metadata.binding, "CF_VERSION_METADATA");
  }
  assert.deepEqual(config.env.development.vars, { RUNMESH_ENVIRONMENT: "development",
    CENTRAL_SKILLS_ENABLED: "1", CENTRAL_DIRECT_TOOLS_ENABLED: "1", CENTRAL_GOVERNANCE_ENABLED: "1" });
});
