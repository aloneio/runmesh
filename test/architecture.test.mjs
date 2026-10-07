import { parse } from "@babel/parser";
import { checkArchitecture } from "../scripts/architecture-graph.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkCommand } from "../scripts/ci-contract.mjs";
import { bundleRunner } from "../scripts/build-runner-bundle.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
test("catalog, maintenance and byte-reading consumers retain their scoped structural ports", () => {
  const result = spawnSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--types", "node", "--ignoreConfig",
    join(project, "test/fixtures/catalog-read-ports.ts"),
    join(project, "test/fixtures/service-profile-ports.ts"),
    join(project, "test/fixtures/positioned-byte-reader.ts")], { cwd: project, encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("admission and browser request rules share values without owning effects", async t => {
  const source = await fixture(t, {
    "apps/worker/src/domain/runner-admission.ts": 'import { validLifecycleId } from "./runner-handshake.js"; export const restore = value => validLifecycleId(value);',
    "apps/worker/src/domain/runner-handshake.ts": 'export const validLifecycleId = value => typeof value === "string";',
    "apps/worker/src/runner-do.ts": 'import "./domain/runner-admission.js";',
    "apps/worker/browser/central/request-contract.js": 'export const serviceOperationScope = id => "mcp:" + id;',
    "apps/worker/browser/central/services.js": 'import "./request-contract.js";',
    "apps/worker/browser/central/service-inspection.js": 'import "./request-contract.js";',
    "apps/worker/browser/central/api.js": 'import "./request-contract.js";',
  });
  const result = await source.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

async function fixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const folder of ["apps/worker/src", "apps/worker/browser", "apps/runner/src", "packages/protocol/src", "scripts"])
    await mkdir(join(root, folder), { recursive: true });
  for (const [file, text] of Object.entries(sources)) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text);
  }
  return { root, run: async () => {
    // Rule fixtures exercise the public scanner directly. Only command-level
    // cases need a copied entrypoint and package resolution in their temp root.
    for (const file of ["check-architecture.mjs", "architecture-graph.mjs", "architecture-policy.mjs", "central-architecture-policy.mjs"])
      await cp(join(project, "scripts", file), join(root, "scripts", file));
    await symlink(join(project, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [join(root, "scripts/check-architecture.mjs")], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "Architecture command must complete rather than be terminated");
    assert.equal(typeof result.status, "number");
    return result;
  } };
}

const bad = [
  ["Runner presence contract owns clock", { "apps/worker/src/contracts/runner-selection.ts": 'export const present = () => Date.now();' }],
  ["Runner presence contract owns scheduling", { "apps/worker/src/contracts/runner-selection.ts": 'export const present = () => setTimeout(() => {}, 1);' }],
  ["Runner presence contract yields", { "apps/worker/src/contracts/runner-selection.ts": 'export const present = async () => true;' }],
  ["Runner presence contract owns storage", { "apps/worker/src/contracts/runner-selection.ts": 'export interface State { storage: SqlStorage }' }],
  ["Runner presence contract imports peer implementation", { "apps/worker/src/contracts/runner-selection.mts": 'import { read } from "./other.js";', "apps/worker/src/contracts/other.ts": 'export const read = () => true;' }],
  ["Administrator session contract to connector identity", { "apps/worker/src/contracts/admin-session.ts": 'import type { AdminDecision } from "./connectors.js";', "apps/worker/src/contracts/connectors.ts": 'export type AdminDecision = {};' }],
  ["Administrator session contract to receipt implementation", { "apps/worker/src/contracts/admin-session.ts": 'import { read } from "./control-plane-receipts.js";', "apps/worker/src/contracts/control-plane-receipts.ts": 'export const read = () => ({});' }],
  ["Administrator session contract to renamed adapter", { "apps/worker/src/contracts/admin-session.mts": 'import type { Receipt } from "./session-helper.js";', "apps/worker/src/contracts/session-helper.ts": 'export type Receipt = {};' }],
  ["Administrator session contract to external schema", { "apps/worker/src/contracts/admin-session.ts": 'import { z } from "zod";' }],
  ["Administrator session contract owns HTTP", { "apps/worker/src/contracts/admin-session.ts": 'export const read = () => Response.json({});' }],
  ["Administrator session contract owns deadline", { "apps/worker/src/contracts/admin-session.ts": 'export const read = () => new AbortController();' }],
  ["Administrator session contract owns storage", { "apps/worker/src/contracts/admin-session.ts": 'export const read = (store: DurableObjectStorage) => store.get("session");' }],
  ["Administrator session contract owns clock", { "apps/worker/src/contracts/admin-session.ts": 'export const read = () => Date.now();' }],
  ["Administrator session contract yields", { "apps/worker/src/contracts/admin-session.ts": 'export async function read() {}' }],
  ["Runner admission to transport types", { "apps/worker/src/domain/runner-admission.ts": 'import type { RunnerDO } from "../runner-do.js";', "apps/worker/src/runner-do.ts": 'export class RunnerDO {}' }],
  ["Runner admission to adapter intermediary", { "apps/worker/src/domain/runner-admission.mts": 'import "./helper.js";', "apps/worker/src/domain/helper.ts": 'export {};' }],
  ["Runner admission owns storage", { "apps/worker/src/domain/runner-admission.ts": 'export const restore = (storage: DurableObjectStorage) => storage.get("admission");' }],
  ["Runner admission owns clock", { "apps/worker/src/domain/runner-admission.ts": 'export const restore = () => Date.now();' }],
  ["Runner admission owns HTTP", { "apps/worker/src/domain/runner-admission.ts": 'export const restore = () => Response.json({});' }],
  ["Runner admission yields while applying rules", { "apps/worker/src/domain/runner-admission.ts": 'export async function restore() {}' }],
  ["Central request contract to DOM locks", { "apps/worker/browser/central/request-contract.js": 'import "./operations.js";', "apps/worker/browser/central/operations.js": 'export {};' }],
  ["Central request contract owns DOM", { "apps/worker/browser/central/request-contract.js": 'export const classify = () => document.body.textContent;' }],
  ["Central request contract owns network", { "apps/worker/browser/central/request-contract.js": 'export const classify = () => fetch("/admin/central");' }],
  ["Central request contract owns scheduling", { "apps/worker/browser/central/request-contract.js": 'export const classify = () => setTimeout(() => {}, 1);' }],
  ["Skill lifecycle receipts to domain rules", { "apps/worker/src/contracts/skill-lifecycle-receipts.ts": 'import "../domain/skills/lifecycle.js";', "apps/worker/src/domain/skills/lifecycle.ts": "export {};" }],
  ["Skill lifecycle values to HTTP adapter", { "apps/worker/src/contracts/skill-lifecycle-values.ts": 'import "../http/central-skill-lifecycle.js";', "apps/worker/src/http/central-skill-lifecycle.ts": "export {};" }],
  ["Skill lifecycle receipts to storage", { "apps/worker/src/contracts/skill-lifecycle-receipts.ts": 'import "../platform/skills/lifecycle-store.js";', "apps/worker/src/platform/skills/lifecycle-store.ts": "export {};" }],
  ["Skill lifecycle receipts own network", { "apps/worker/src/contracts/skill-lifecycle-receipts.ts": 'export const project = () => fetch("https://example.invalid");' }],
  ["central failure classification to controller", { "apps/worker/browser/central/failures.js": 'import "./controller.js";', "apps/worker/browser/central/controller.js": "export {};" }],
  ["central failure classification owns DOM", { "apps/worker/browser/central/failures.js": 'export const classify = () => document.body.textContent;' }],
  ["central failure classification owns network", { "apps/worker/browser/central/failures.js": 'export const classify = () => fetch("/admin/central");' }],
  ["central failure classification owns scheduling", { "apps/worker/browser/central/failures.js": 'export const classify = () => setTimeout(() => {}, 1);' }],
  ["central failure classification owns clock", { "apps/worker/browser/central/failures.js": 'export const classify = () => Date.now();' }],
  ["Skill lifecycle contract to storage implementation", { "apps/worker/src/contracts/skill-lifecycle.ts": 'import "../platform/skills/lifecycle-store.js";', "apps/worker/src/platform/skills/lifecycle-store.ts": "export {};" }],
  ["Skill source use case to GitHub adapter", { "apps/worker/src/application/skills/source.ts": 'import "../../platform/skills/github-source.js";', "apps/worker/src/platform/skills/github-source.ts": "export {};" }],
  ["Skill source contracts to parser package", { "apps/worker/src/contracts/skill-source-values.ts": 'import "yaml";' }],
  ["Skill source value contracts to domain parser", { "apps/worker/src/contracts/skill-source-values.ts": 'import "../domain/skills/frontmatter.js";', "apps/worker/src/domain/skills/frontmatter.ts": "export {};" }],
  ["Skill source adapter to parser through a contract barrel", {
    "apps/worker/src/platform/skills/github-source.ts": 'import "../../contracts/skill-source-values.js";',
    "apps/worker/src/contracts/skill-source-values.ts": 'export * from "../domain/skills/frontmatter.js";',
    "apps/worker/src/domain/skills/frontmatter.ts": "export {};",
  }],
  ["Skill YAML review does not permit use-case parser imports", { "apps/worker/src/application/skills/source.ts": 'import "yaml";' }],
  ["Skill YAML review does not permit sibling parser imports", { "apps/worker/src/domain/skills/other-frontmatter.ts": 'import "yaml";' }],
  ["Skill YAML review does not permit package subpaths", { "apps/worker/src/domain/skills/frontmatter.ts": 'import "yaml/browser";' }],
  ["Skill YAML review does not permit network I/O", { "apps/worker/src/domain/skills/frontmatter.ts": 'import "yaml"; export const load = () => fetch("https://example.invalid");' }],
  ["Skill source deadline exception does not permit other foundations", { "apps/worker/src/application/skills/source-deadline.ts": 'import "../../security.js";', "apps/worker/src/security.ts": "export {};" }],
  ["Skill source deadline exception does not permit adapter types", { "apps/worker/src/application/skills/source-deadline.ts": 'import type { Adapter } from "../../platform/skills/github-source.js";', "apps/worker/src/platform/skills/github-source.ts": "export type Adapter = {};" }],
  ["Skill source use case cannot bypass its deadline wrapper", { "apps/worker/src/application/skills/source.ts": 'import "../../async-deadline.js";', "apps/worker/src/async-deadline.ts": "export {};" }],
  ["tool search to remote connector implementation", { "apps/worker/src/application/capabilities/search.ts": 'import "../../platform/connectors/remote-client.js";', "apps/worker/src/platform/connectors/remote-client.ts": "export {};" }],
  ["connection inspection to Skill repository", { "apps/worker/src/application/connectors/inspection.ts": 'import "../../platform/skills/store.js";', "apps/worker/src/platform/skills/store.ts": "export {};" }],
  ["Skill history browser workflow bypasses API port", { "apps/worker/browser/central/skill-history.js": 'export const load = () => fetch("/admin/central/skills");' }],
  ["update contracts through native-service contracts to adapter", {
    "apps/runner/src/updates/contracts.ts": 'export type { Snapshot } from "../services/contracts.js";',
    "apps/runner/src/services/contracts.ts": 'export type { Snapshot } from "../updates/native-service.js";',
    "apps/runner/src/updates/native-service.ts": 'export type Snapshot = {};',
  }],
  ["native-service contracts to HTTP adapter", { "apps/runner/src/services/contracts.ts": 'export * from "../updates/cloud.js";', "apps/runner/src/updates/cloud.ts": 'export {};' }],
  ["native-service contracts through intermediary", { "apps/runner/src/services/contracts.cts": 'export * from "./helper.js";', "apps/runner/src/services/helper.ts": 'export * from "../updates/cloud.js";', "apps/runner/src/updates/cloud.ts": 'export {};' }],
  ["native-service contracts to platform types", { "apps/runner/src/services/contracts.mts": 'import type { PathLike } from "node:fs";' }],
  ["published native-service contracts to protocol package types", { "apps/runner/src/services/contracts.ts": 'import type { PermissionSet } from "@aloneio/runmesh-protocol";', "packages/protocol/src/index.ts": 'export type PermissionSet = {};' }],
  ["published native-service contracts to relative protocol types", { "apps/runner/src/services/contracts.ts": 'export type { PermissionSet } from "../../../../packages/protocol/src/index.js";', "packages/protocol/src/index.ts": 'export type PermissionSet = {};' }],
  ["native-service contracts own process state", { "apps/runner/src/services/contracts.ts": 'export const platform = process.platform;' }],
  ["native-service contracts own scheduling", { "apps/runner/src/services/contracts.ts": 'export const delay = () => setTimeout(() => {}, 100);' }],
  ["update coordinator to HTTP adapter", { "apps/runner/src/updates/coordinator.ts": 'import "./cloud.js";', "apps/runner/src/updates/cloud.ts": "export {};" }],
  ["update contracts to native adapter types", { "apps/runner/src/updates/contracts.mts": 'import type { Snapshot } from "./native-service.js";', "apps/runner/src/updates/native-service.ts": "export type Snapshot = {};" }],
  ["update coordinator through intermediary", { "apps/runner/src/updates/coordinator.cts": 'export * from "./helper.js";', "apps/runner/src/updates/helper.ts": 'export * from "./cloud.js";', "apps/runner/src/updates/cloud.ts": "export {};" }],
  ["update coordinator to filesystem", { "apps/runner/src/updates/coordinator.ts": 'import "node:fs/promises";' }],
  ["update contracts to platform types", { "apps/runner/src/updates/contracts.ts": 'import type { PathLike } from "node:fs";' }],
  ["update coordinator owns network", { "apps/runner/src/updates/coordinator.ts": 'export const poll = () => fetch("https://example.invalid");' }],
  ["update contracts own process state", { "apps/runner/src/updates/contracts.ts": 'export const platform = process.platform;' }],
  ["shared deadline to feature implementation", { "apps/worker/src/async-deadline.ts": 'import "./application/connectors/deadline.js";', "apps/worker/src/application/connectors/deadline.ts": "export {};" }],
  ["shared deadline to platform dependency", { "apps/worker/src/async-deadline.mts": 'import "./platform/control-plane.js";', "apps/worker/src/platform/control-plane.ts": "export {};" }],
  ["shared deadline to package", { "apps/worker/src/async-deadline.ts": 'import "zod";' }],
  ["shared deadline owns network", { "apps/worker/src/async-deadline.ts": 'export const execute = () => fetch("https://example.invalid");' }],
  ["central deadline exception does not expose other foundations", { "apps/worker/src/application/connectors/deadline.ts": 'import "../../security.js";', "apps/worker/src/security.ts": "export {};" }],
  ["central deadline exception does not expose arbitrary callers", { "apps/worker/src/application/skills/reader.ts": 'import "../../async-deadline.js";', "apps/worker/src/async-deadline.ts": "export {};" }],
  ["fragment utility to page lifecycle", { "apps/worker/browser/fragment.js": 'import "./admin-pages.js";', "apps/worker/browser/admin-pages.js": "export {};" }],
  ["maintenance entry to ordinary CLI", { "apps/runner/src/maintenance-entry.ts": 'import "./cli.js";', "apps/runner/src/cli.ts": "export {};" }],
  ["maintenance agent to Runner runtime", { "apps/runner/src/updates/agent.ts": 'import "../runtime.js";', "apps/runner/src/runtime.ts": "export {};" }],
  ["maintenance agent to ordinary supervisor", { "apps/runner/src/updates/agent.ts": 'import "../cli/supervisor.js";', "apps/runner/src/cli/supervisor.ts": "export {};" }],
  ["maintenance imports concrete job metadata", { "apps/runner/src/updates/job-drain.ts": 'import "../jobs/records.js";', "apps/runner/src/jobs/records.ts": "export {};" }],
  ["maintenance to unreviewed new Runner module", { "apps/runner/src/updates/new.mts": 'import "../new-runtime.js";', "apps/runner/src/new-runtime.ts": "export {};" }],
  ["maintenance to WebSocket package", { "apps/runner/src/updates/new.ts": 'import "ws";' }],
  ["maintenance reaches runtime through a shared helper", { "apps/runner/src/maintenance-cli.ts": 'import "./cli/lifecycle.js";', "apps/runner/src/cli/lifecycle.ts": 'import "../runtime.js";', "apps/runner/src/runtime.ts": "export {};" }],
  ["maintenance reaches new execution code through profile", { "apps/runner/src/updates/agent.ts": 'import "../profile.js";', "apps/runner/src/profile.ts": 'import "./new-runtime.js";', "apps/runner/src/new-runtime.ts": "export {};" }],
  ["Registry facade to release rules", { "apps/worker/src/registry.ts": 'import "./domain/release-selection.js";', "apps/worker/src/domain/release-selection.ts": "export {};" }],
  ["Registry release admission to other domain", { "apps/worker/src/registry/release-cache.ts": 'import "../domain/release-config.js";', "apps/worker/src/domain/release-config.ts": "export {};" }],
  ["Registry release admission to storage", { "apps/worker/src/registry/release-cache.ts": 'import "./storage.js";', "apps/worker/src/registry/storage.ts": "export {};" }],
  ["Registry release admission to network adapter", { "apps/worker/src/registry/release-cache.ts": 'import "../distribution/release-io.js";', "apps/worker/src/distribution/release-io.ts": "export {};" }],
  ["Registry release admission ambient clock", { "apps/worker/src/registry/release-cache.ts": 'export const update = () => Date.now();' }],
  ["Registry release admission network", { "apps/worker/src/registry/release-cache.mts": 'export const update = () => fetch("https://example.invalid");' }],
  ["Registry release admission cannot yield", { "apps/worker/src/registry/release-cache.ts": 'export async function update() {}' }],
  ["history display defaults own SQL", { "apps/worker/src/job-history-settings.ts": 'export function initialize(sql: SqlStorage) { sql.exec("SELECT 1"); }' }],
  ["history display defaults own network", { "apps/worker/src/job-history-settings.mts": 'export const load = () => fetch("https://example.invalid");' }],
  ["application to concrete platform adapter", { "apps/worker/src/application/query.ts": 'import "../platform/control-plane.js";', "apps/worker/src/platform/control-plane.ts": "export {};" }],
  ["application to platform environment types", { "apps/worker/src/application/query.mts": 'import type { WorkerEnv } from "../platform/env.js";', "apps/worker/src/platform/env.ts": "export type WorkerEnv = {};" }],
  ["request use case owns HTTP response", { "apps/worker/src/application/runner-queries.ts": 'export const reply = () => Response.json({});' }],
  ["request use case reads incoming HTTP headers", { "apps/worker/src/application/auth-source.ts": 'export const source = (request: Request) => request.headers.get("cf-connecting-ip");' }],
  ["request use case owns randomness", { "apps/worker/src/application/enrollment.cts": 'export const code = () => crypto.randomUUID();' }],
  ["request use case owns network", { "apps/worker/src/application/mcp-identity.ts": 'export const verify = () => fetch("https://example.invalid");' }],
  ["shared schema helper to request state", { "apps/worker/src/mcp/providers/schema-publication.ts": 'import "../server.js";', "apps/worker/src/mcp/server.ts": "export {};" }],
  ["shared schema helper to client SDK", { "apps/worker/src/mcp/providers/schema-publication.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["shared schema helper to ambient network", { "apps/worker/src/mcp/providers/schema-publication.ts": 'export const load = () => fetch("https://example.invalid");' }],
  ["shared storage cipher to catalog contract", { "apps/worker/src/platform/secret-storage.ts": 'import "../contracts/catalog-json.js";', "apps/worker/src/contracts/catalog-json.ts": 'export {};' }],
  ["shared ciphertext contract to capability contract", { "apps/worker/src/contracts/secret-storage.ts": 'import "./capabilities.js";', "apps/worker/src/contracts/capabilities.ts": 'export {};' }],
  ["shared serializer to feature contract", { "apps/worker/src/contracts/json.ts": 'import "./catalog.js";', "apps/worker/src/contracts/catalog.ts": 'export {};' }],
  ["shared serializer to provider SDK", { "apps/worker/src/contracts/json.ts": 'import "@modelcontextprotocol/client";' }],
  ["duplicate Worker storage cipher", { "apps/worker/src/platform/other.ts": 'export const algorithm = "AES-GCM";' }],
  ["shared storage cipher to feature implementation", { "apps/worker/src/platform/secret-storage.ts": 'import "./connectors/managed-store.js";', "apps/worker/src/platform/connectors/managed-store.ts": 'export {};' }],
  ["Handshake to asynchronous projection", { "apps/worker/src/domain/runner-handshake.ts": 'export async function project() { return {}; }' }],
  ["Environment contracts to platform types", { "apps/runner/src/environment-contracts.ts": 'import type { PathLike } from "node:fs";' }],
  ["Handshake to transport owner", { "apps/worker/src/domain/runner-handshake.ts": 'import "../runner-do.js";', "apps/worker/src/runner-do.ts": 'export {};' }],
  ["Handshake to adapter types", { "apps/worker/src/domain/runner-handshake.ts": 'import type { Binding } from "../platform/env.js";', "apps/worker/src/platform/env.ts": 'export type Binding = {};' }],
  ["Handshake to ambient clock", { "apps/worker/src/domain/runner-handshake.ts": 'export const now = Date.now();' }],
  ["Handshake to scheduling", { "apps/worker/src/domain/runner-handshake.ts": 'export const schedule = queueMicrotask;' }],
  ["Environment contracts to native probes", { "apps/runner/src/environment-contracts.ts": 'import type { EnvironmentInfoService } from "./environment.js";', "apps/runner/src/environment.ts": 'export class EnvironmentInfoService {}' }],
  ["Environment contracts to process state", { "apps/runner/src/environment-contracts.ts": 'export const platform = process.platform;' }],
  ["Environment contracts to filesystem", { "apps/runner/src/environment-contracts.ts": 'import "node:fs";' }],
  ["CLI contract to environment implementation", { "apps/runner/src/cli/contracts.ts": 'import type { EnvironmentInfoService } from "../environment.js";', "apps/runner/src/environment.ts": 'export class EnvironmentInfoService {}' }],
  ["Environment adapter to runtime", { "apps/runner/src/environment.ts": 'import "./runtime.js";', "apps/runner/src/runtime.ts": 'export {};' }],
  ["Runner creation to transport", { "apps/worker/src/application/create-runner.ts": 'import "../platform/runner-mutations.js";', "apps/worker/src/platform/runner-mutations.ts": 'export {};' }],
  ["Runner registration to HTTP response", { "apps/worker/src/application/register-runner.ts": 'export const result = () => new Response();' }],
  ["Runner policy to ambient network", { "apps/worker/src/application/runner-policy.ts": 'export const mutate = () => fetch("https://example.invalid");' }],
  ["Runner enrollment to platform types", { "apps/worker/src/application/runner-enrollment.ts": 'export type Binding = DurableObjectNamespace;' }],
  ["Runner lifecycle to concrete SDK", { "apps/worker/src/application/runner-lifecycle.ts": 'import "undici";' }],
  ["Registry history coordinator to concrete store", { "apps/worker/src/registry/history-routes.ts": 'import "../job-history-store.js";', "apps/worker/src/job-history-store.ts": 'export {};' }],
  ["Registry transport coordinator to ambient network", { "apps/worker/src/registry/transport-routes.ts": 'export const connect = () => fetch("https://example.invalid");' }],
  ["Registry lifecycle routes cannot yield", { "apps/worker/src/registry/routes/runner-lifecycle.ts": 'export async function mutate() {}' }],
  ["Browser navigation cannot depend on controls", { "apps/worker/browser/admin-navigation.js": 'import "./page-controls.js";', "apps/worker/browser/page-controls.js": 'export {};' }],
  ["Browser controls cannot depend on navigation", { "apps/worker/browser/page-controls.js": 'import "./admin-navigation.js";', "apps/worker/browser/admin-navigation.js": 'export {};' }],
  ["managed OAuth contracts to SDK", { "apps/worker/src/contracts/managed-oauth.ts": 'import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";' }],
  ["managed connection contracts to platform globals", { "apps/worker/src/contracts/managed-connections.ts": 'export const request = globalThis.fetch;' }],
  ["managed OAuth use case to protocol adapter", { "apps/worker/src/application/connectors/managed-oauth.ts": 'import "../../platform/connectors/managed-oauth.js";', "apps/worker/src/platform/connectors/managed-oauth.ts": 'export {};' }],
  ["managed OAuth protocol to storage", { "apps/worker/src/platform/connectors/managed-oauth.ts": 'import type { State } from "./managed-store.js";', "apps/worker/src/platform/connectors/managed-store.ts": 'export type State = {};' }],
  ["managed OAuth protocol to cipher", { "apps/worker/src/platform/connectors/managed-oauth.ts": 'import "../secret-storage.js";', "apps/worker/src/platform/secret-storage.ts": 'export {};' }],
  ["managed OAuth storage to SDK", { "apps/worker/src/platform/connectors/managed-store.ts": 'import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";' }],
  ["managed OAuth storage to SDK intermediary", { "apps/worker/src/platform/connectors/managed-store.ts": 'import type { Metadata } from "./provider-types.js";', "apps/worker/src/platform/connectors/provider-types.ts": 'export type Metadata = {};' }],
  ["OAuth contracts to SDK", { "apps/worker/src/contracts/oauth.ts": 'import { Client } from "@modelcontextprotocol/client";' }],
  ["OAuth rules to native Runner state", { "apps/worker/src/application/connectors/oauth.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["remote capability to OAuth persistence", { "apps/worker/src/application/capabilities/remote-call.ts": 'import "../../platform/connectors/managed-store.js";', "apps/worker/src/platform/connectors/managed-store.ts": "export {};" }],
  ["remote contract to client SDK", { "apps/worker/src/contracts/remote.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["remote invocation to concrete credential adapter", { "apps/worker/src/application/capabilities/remote-call.ts": 'import "../../platform/connectors/cipher.js";', "apps/worker/src/platform/connectors/cipher.ts": "export {};" }],
  ["remote provider to state owner", { "apps/worker/src/mcp/providers/remote.ts": 'import "../../capabilities-do.js";', "apps/worker/src/capabilities-do.ts": "export {};" }],
  ["central provider to concrete connector", { "apps/worker/src/mcp/providers/remote.ts": 'import "../../platform/connectors/remote-client.js";', "apps/worker/src/platform/connectors/remote-client.ts": "export {};" }],
  ["central provider to concrete Skill store type", { "apps/worker/src/mcp/providers/skills.mts": 'import type { State } from "../../platform/skills/store.mjs";', "apps/worker/src/platform/skills/store.mts": "export type State = {};" }],
  ["central provider helper reexports concrete cipher", { "apps/worker/src/mcp/providers/remote/helper.ts": 'export * from "../../../platform/secret-storage.js";', "apps/worker/src/platform/secret-storage.ts": "export {};" }],
  ["central provider helper dynamically loads concrete Skill store", { "apps/worker/src/mcp/providers/skills/helper.cts": 'void import("../../../platform/skills/store.cjs");', "apps/worker/src/platform/skills/store.cts": "export {};" }],
  ["central provider to client SDK types", { "apps/worker/src/mcp/providers/remote.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["central provider to unreviewed HTTP package", { "apps/worker/src/mcp/providers/remote.ts": 'import { request } from "undici";' }],
  ["central provider helper direct network", { "apps/worker/src/mcp/providers/remote/request.ts": 'export const load = () => fetch("https://example.invalid");' }],
  ["central provider helper platform alias", { "apps/worker/src/mcp/providers/skills/request.mts": 'const platform = globalThis; export const load = platform["fetch"];' }],
  ["remote request parser to network", { "apps/worker/src/contracts/remote-values.ts": 'export const connect = globalThis.fetch;' }],
  ["catalog schema contract to SDK", { "apps/worker/src/contracts/catalog-schema.ts": 'import "@modelcontextprotocol/client";' }],
  ["catalog reader to credential implementation", { "apps/worker/src/application/capabilities/catalog-read.ts": 'import "../../platform/connectors/cipher.js";', "apps/worker/src/platform/connectors/cipher.ts": "export {};" }],
  ["catalog rules to live HTTP", { "apps/worker/src/domain/capabilities/catalog.ts": 'export const discover = () => fetch("https://example.invalid");' }],
  ["catalog storage to native Runner state", { "apps/worker/src/platform/capabilities/catalog-store.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["central owner to native application", { "apps/worker/src/capabilities-do.ts": 'import "./application/delete-runner.js";', "apps/worker/src/application/delete-runner.ts": "export {};" }],
  ["central application direct network", { "apps/worker/src/application/connectors/profiles.ts": 'export const request = () => fetch("https://example.invalid");' }],
  ["central contract helper platform global", { "apps/worker/src/contracts/connector-values.ts": 'export const request = globalThis.fetch;' }],
  ["central pure global fetch", { "apps/worker/src/domain/skills/import.ts": 'export const load = () => fetch("https://example.invalid");' }],
  ["central pure global alias", { "apps/worker/src/domain/connectors/check.ts": 'const root = globalThis; export const load = root["fetch"];' }],
  ["central contract to Runner wire", { "apps/worker/src/contracts/capabilities.ts": 'import type { Wire } from "@aloneio/runmesh-protocol";', "packages/protocol/src/index.ts": "export type Wire = {};" }],
  ["native code to central internals", { "apps/worker/src/mcp/server.ts": 'import "../platform/capabilities/owner.js";', "apps/worker/src/platform/capabilities/owner.ts": "export {};" }],
  ["unreviewed central directory without imports", { "apps/worker/src/skills/read.ts": 'export const read = () => "unchecked";' }],
  ["central dynamic code evaluation", { "apps/worker/src/platform/skills/load.ts": 'export const load = (source: string) => new Function(source);' }],
  ["central Skill to Runner shell", { "apps/worker/src/application/skills/read.ts": 'import "../../../../runner/src/jobs.js";', "apps/runner/src/jobs.ts": "export {};" }],
  ["central connector to RunnerDO", { "apps/worker/src/platform/connectors/client.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["central feature peer internals", { "apps/worker/src/application/connectors/invoke.ts": 'import "../skills/read.js";', "apps/worker/src/application/skills/read.ts": "export {};" }],
  ["unreviewed central directories", { "apps/worker/src/connectors/client.ts": 'import "../skills/read.js";', "apps/worker/src/skills/read.ts": "export {};" }],
  ["central pure rule to SDK type", { "apps/worker/src/domain/connectors/validate.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["central rule to environment type", { "apps/worker/src/domain/capabilities/grants.ts": 'import type { WorkerEnv } from "../../platform/env.js";', "apps/worker/src/platform/env.ts": "export type WorkerEnv = {};" }],
  ["central use case to concrete storage", { "apps/worker/src/application/skills/read.ts": 'import "../../platform/skills/store.js";', "apps/worker/src/platform/skills/store.ts": "export {};" }],
  ["central Skill process execution", { "apps/worker/src/platform/skills/import.ts": 'import { spawn } from "node:child_process";' }],
  ["central MCP provider to application", { "apps/worker/src/mcp/providers/remote.ts": 'import "../../application/connectors/invoke.js";', "apps/worker/src/application/connectors/invoke.ts": "export {};" }],
  ["central connector to Runner wire contract", { "apps/worker/src/domain/connectors/state.ts": 'import type { Wire } from "@aloneio/runmesh-protocol";', "packages/protocol/src/index.ts": "export type Wire = {};" }],
  ["stdin delivery to filesystem", { "apps/runner/src/jobs/input.ts": 'import { readFile } from "node:fs/promises";' }],
  ["stdin delivery to process adapter", { "apps/runner/src/jobs/input.ts": 'import "./process.js";', "apps/runner/src/jobs/process.ts": "export {};" }],
  ["stdin delivery to storage adapter", { "apps/runner/src/jobs/input.ts": 'import "./storage.js";', "apps/runner/src/jobs/storage.ts": "export {};" }],
  ["stdin delivery loads stream implementation", { "apps/runner/src/jobs/input.ts": 'import { Writable } from "node:stream";' }],
  ["service adapter to service facade", { "apps/runner/src/services/systemd.ts": 'import "../service.js";', "apps/runner/src/service.ts": "export {};" }],
  ["command to CLI facade", { "apps/runner/src/cli/doctor.ts": 'import "../cli.js";', "apps/runner/src/cli.ts": "export {};" }],
  ["patch planner to file mutator", { "apps/runner/src/patch/parse.ts": 'import "./files.js";', "apps/runner/src/patch/files.ts": "export {};" }],
  ["browser to Worker application", { "apps/worker/browser/main.js": 'import "../src/application/delete-runner.js";', "apps/worker/src/application/delete-runner.ts": "export {};" }],
  ["browser service to Skill workflow", { "apps/worker/browser/central/services.js": 'import "./skills.js";', "apps/worker/browser/central/skills.js": "export {};" }],
  ["browser API to controller", { "apps/worker/browser/central/api.js": 'import "./controller.js";', "apps/worker/browser/central/controller.js": "export {};" }],
  ["browser workflow direct fetch", { "apps/worker/browser/central/services.js": 'export const discover = () => fetch("https://example.invalid");' }],
  ["browser view aliased network", { "apps/worker/browser/central/view.mjs": 'const platform = globalThis; export const load = platform["fetch"];' }],
  ["browser API owns DOM", { "apps/worker/browser/central/api.js": 'export const find = () => document.querySelector("form");' }],
  ["browser copy owns navigation", { "apps/worker/browser/central/messages.js": 'export const locale = location.href;' }],
  ["Registry route parser to domain owner", { "apps/worker/src/registry/route-inputs.ts": 'import "./auth.js";', "apps/worker/src/registry/auth.ts": "export {};" }],
  ["Registry route projection to persistence", { "apps/worker/src/registry/route-projections.ts": 'import "./storage.js";', "apps/worker/src/registry/storage.ts": "export {};" }],
  ["Registry route parser ambient clock", { "apps/worker/src/registry/route-inputs.mts": 'export const expires = () => Date.now();' }],
  ["Registry route projection network", { "apps/worker/src/registry/route-projections.ts": 'export const project = () => fetch("https://example.invalid");' }],
  ["Registry route adapter to domain owner", { "apps/worker/src/registry/routes/admin.ts": 'import "../auth.js";', "apps/worker/src/registry/auth.ts": "export {};" }],
  ["Registry route adapter to storage types", { "apps/worker/src/registry/routes/clients.ts": 'import type { Store } from "../storage.js";', "apps/worker/src/registry/storage.ts": "export type Store = {};" }],
  ["Registry route adapter to peer adapter", { "apps/worker/src/registry/routes/admin.ts": 'import "./clients.js";', "apps/worker/src/registry/routes/clients.ts": "export {};" }],
  ["Registry domain to route adapter", { "apps/worker/src/registry/auth.ts": 'import "./routes/admin.js";', "apps/worker/src/registry/routes/admin.ts": "export {};" }],
  ["Registry route adapter to facade types", { "apps/worker/src/registry/routes/admin.ts": 'import type { RegistryDO } from "../../registry.js";', "apps/worker/src/registry.ts": "export type RegistryDO = {};" }],
  ["Registry route adapter asynchronous function", { "apps/worker/src/registry/routes/clients.ts": 'export const route = async () => new Response();' }],
  ["Registry route adapter scheduled mutation", { "apps/worker/src/registry/routes/clients.ts": 'export const route = () => queueMicrotask(() => {});' }],
  ["Registry route adapter ambient clock", { "apps/worker/src/registry/routes/runner-policy.mts": 'export const route = () => Date.now();' }],
  ["Registry route adapter network", { "apps/worker/src/registry/routes/identity.ts": 'export const route = () => fetch("https://example.invalid");' }],
  ["Registry route adapter global storage type", { "apps/worker/src/registry/routes/admin.ts": 'export interface Ports { storage: DurableObjectStorage }' }],

  ["Registry to admin view", { "apps/worker/src/registry/auth.ts": 'import "../admin/client-views.js";', "apps/worker/src/admin/client-views.ts": "export {};" }],
  ["Registry to HTTP", { "apps/worker/src/registry/auth.ts": 'import "../http/html-response.js";', "apps/worker/src/http/html-response.ts": "export {};" }],
  ["view to Registry facade type", { "apps/worker/src/admin/view-models.ts": 'import type { X } from "../registry.js";', "apps/worker/src/registry.ts": "export type X = string;" }],
  ["view to Registry records", { "apps/worker/src/admin/view-models.ts": 'export type { X } from "../registry/records.js";', "apps/worker/src/registry/records.ts": "export type X = string;" }],
  ["use case to HTTP", { "apps/worker/src/application/example.ts": 'void import("../http/input.js");', "apps/worker/src/http/input.ts": "export {};" }],
  ["projection to dispatch", { "apps/worker/src/mcp/results/files.ts": 'import "../dispatch.js";', "apps/worker/src/mcp/dispatch.ts": "export {};" }],
  ["renamed wrapper cannot bypass domain boundary", { "apps/worker/src/registry/auth.ts": 'import "../renamed.js";', "apps/worker/src/renamed.ts": 'export * from "./admin/format.js";', "apps/worker/src/admin/format.ts": "export {};" }],
  ["Job adapter to manager", { "apps/runner/src/jobs/storage.ts": 'import "../jobs.js";', "apps/runner/src/jobs.ts": "export {};" }],
  ["Context adapter to facade", { "apps/runner/src/context/repository.ts": 'import "../context-store.js";', "apps/runner/src/context-store.ts": "export {};" }],
  ["log reader to process executor", { "apps/runner/src/jobs/logs.ts": 'import "./process.js";', "apps/runner/src/jobs/process.ts": "export {};" }],
  ["Context model to file adapter", { "apps/runner/src/context/model.ts": 'import "./files.js";', "apps/runner/src/context/files.ts": "export {};" }],
  ["pure planner to inventory adapter", { "apps/runner/src/context/retention-plan.ts": 'import type { Inventory } from "../context-storage.js";', "apps/runner/src/context-storage.ts": "export type Inventory = {};" }],
  ["pure planner filesystem access", { "apps/runner/src/context/retention-plan.ts": 'import { readFile } from "node:fs/promises";' }],
  ["pure Job model process access", { "apps/runner/src/jobs/records.ts": 'import { spawn } from "node:child_process";' }],
  ["Runner ports to concrete adapter", { "apps/runner/src/jobs/ports.ts": 'import type { State } from "./storage.js";', "apps/runner/src/jobs/storage.ts": "export type State = {};" }],
  ["Registry domain to facade", { "apps/worker/src/registry/auth.ts": 'import { RegistryDO } from "../registry.js";', "apps/worker/src/registry.ts": "export class RegistryDO {}" }],
  ["Registry domain to concrete peer", { "apps/worker/src/registry/auth.ts": 'import { RegistryPolicy } from "./policy.js";', "apps/worker/src/registry/policy.ts": "export class RegistryPolicy {}" }],
  ["Registry contract to implementation", { "apps/worker/src/registry/ports.ts": 'import type { RegistryAuth } from "./auth.js";', "apps/worker/src/registry/auth.ts": "export class RegistryAuth {}" }],
  ["Registry domain to remote history adapter", { "apps/worker/src/registry/history.ts": 'import { PackedJobHistory } from "../job-history-store.js";', "apps/worker/src/job-history-store.ts": "export class PackedJobHistory {}" }],
  ["Registry domain to MCP handler", { "apps/worker/src/registry/policy.ts": 'import "../mcp/server.js";', "apps/worker/src/mcp/server.ts": "export {};" }],
  ["Worker to Runner", { "apps/worker/src/a.ts": 'import "../../runner/src/b.js";', "apps/runner/src/b.ts": "export {};" }],
  ["Runner to Worker", { "apps/runner/src/a.ts": 'export * from "../../worker/src/b.js";', "apps/worker/src/b.ts": "export {};" }],
  ["protocol reverse import", { "packages/protocol/src/a.ts": 'import "../../../apps/runner/src/b.js";', "apps/runner/src/b.ts": "export {};" }],
  ["dynamic reverse import", { "packages/protocol/src/a.ts": 'void import("../../../apps/worker/src/b.js");', "apps/worker/src/b.ts": "export {};" }],
  ["protocol Node import", { "packages/protocol/src/a.ts": 'import { readFile } from "node:fs/promises";' }],
  ["bare Node built-in", { "packages/protocol/src/a.ts": 'export * from "fs";' }],
  ["Worker Node side effect", { "apps/worker/src/a.ts": 'require("node:child_process");' }],
  ["runtime cycle", { "apps/runner/src/a.ts": 'import "./b.js";', "apps/runner/src/b.ts": 'import "./a.js";' }],
  ["computed dynamic import", { "apps/runner/src/a.ts": 'const path = "./other.js"; void import(path);' }],
  ["template dynamic import", { "apps/runner/src/a.ts": 'void import(`./${name}.js`);' }],
  ["type reverse import", { "packages/protocol/src/a.ts": 'type A = import("../../../apps/worker/src/b.js").B;', "apps/worker/src/b.ts": "export type B = string;" }],
  ["package cross-app import", { "apps/worker/src/a.ts": 'import "@aloneio/runmesh-runner";', "apps/runner/src/index.ts": "export {};" }],
  ["unresolved source", { "apps/runner/src/a.ts": 'import "./missing.js";' }],
  ["syntax failure", { "apps/runner/src/a.ts": 'import {' }],
  ["configuration to installer", { "apps/worker/src/runtime-config.ts": 'import "./installer.js";', "apps/worker/src/installer.ts": "export {};" }],
  ["contract to implementation", { "apps/worker/src/contracts/selection.ts": 'import type { X } from "../registry.js";', "apps/worker/src/registry.ts": "export type X = string;" }],
  ["MCP concrete transport type", { "apps/worker/src/mcp/server.ts": 'import type { Env } from "../runner-do.js";', "apps/worker/src/runner-do.ts": "export type Env = {};" }],
  ["MCP concrete Registry type", { "apps/worker/src/mcp/server.ts": 'import type { State } from "../registry.js";', "apps/worker/src/registry.ts": "export type State = {};" }],
  ["retired runtime setting", { "apps/runner/src/a.ts": 'export const x = "RUNMESH_SCHEMA_READY";' }],
];

test("maintenance shares host adapters and types without acquiring execution dependencies", async t => {
  const f = await fixture(t, {
    "apps/runner/src/maintenance-entry.ts": 'import "./maintenance-cli.js";',
    "apps/runner/src/maintenance-cli.ts": 'import "./cli/lifecycle.js"; import "./updates/agent.js";',
    "apps/runner/src/cli/lifecycle.ts": 'import "../profile.js"; import "../service.js";',
    "apps/runner/src/profile.ts": 'import type { Config } from "./config.js";',
    "apps/runner/src/config.ts": 'export type Config = {};',
    "apps/runner/src/service.ts": 'export * from "./services/layout.js";',
    "apps/runner/src/services/layout.ts": 'import "node:path";',
    "apps/runner/src/updates/agent.ts": 'import "./job-drain.js"; import "../backoff.js";',
    "apps/runner/src/backoff.ts": await readFile(join(project, "apps/runner/src/backoff.ts"), "utf8"),
    "apps/runner/src/updates/job-drain.ts": 'import "../maintenance-contract.js"; import "node:fs/promises";',
    "apps/runner/src/maintenance-contract.ts": 'export const terminal = (value: string) => value === "succeeded";',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("shared Runner backoff rejects imports, I/O and scheduling", async t => {
  for (const source of [
    'import "./runtime.js";',
    'import "node:fs/promises";',
    'import type { Timer } from "node:timers";',
    'export const delay = () => fetch("https://example.invalid");',
    'export const delay = () => setTimeout(() => {}, 100);',
    'export const delay = () => queueMicrotask(() => {});',
    'export const delay = () => localStorage.getItem("delay");',
    'export const delay = () => globalThis["fetch"];',
    'export const delay = async () => 100;',
  ]) {
    const f = await fixture(t, {
      "apps/runner/src/backoff.ts": source,
      "apps/runner/src/runtime.ts": 'export {};',
    });
    assert.ok((await checkArchitecture(f.root)).failures.length > 0, source);
  }
});

test("update coordination uses shared ports while retaining local scheduling", async t => {
  const f = await fixture(t, {
    "apps/runner/src/updates/coordinator.ts": 'import { Failure } from "./contracts.js"; export const delay = () => new Promise(resolve => setTimeout(resolve, performance.now()));',
    "apps/runner/src/updates/contracts.ts": 'import type { Snapshot } from "../services/contracts.js"; import "@aloneio/runmesh-protocol"; export class Failure extends Error {}',
    "apps/runner/src/services/contracts.ts": 'export type Snapshot = { readonly active: boolean };',
    "packages/protocol/src/index.ts": 'export {};',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("feature deadline wrappers share scheduling without exposing peer implementations", async t => {
  const f = await fixture(t, {
    "apps/worker/src/application/connectors/deadline.ts": 'import "../../async-deadline.js";',
    "apps/worker/src/application/capabilities/remote-deadline.ts": 'import "../../async-deadline.js";',
    "apps/worker/src/application/skills/source-deadline.ts": await readFile(join(project, "apps/worker/src/application/skills/source-deadline.ts"), "utf8"),
    "apps/worker/src/contracts/skill-source.ts": 'export const SKILL_SOURCE_LIMITS = { operation_ms: 25000 };',
    "apps/worker/src/async-deadline.ts": 'export const delay = () => setTimeout(() => new AbortController().abort(), 100);',
    "apps/worker/browser/page-controls.js": 'import "./fragment.js";',
    "apps/worker/browser/admin-pages.js": 'import "./fragment.js";',
    "apps/worker/browser/fragment.js": 'export const target = (root, id) => root.querySelector(id);',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("Skill source syntax contracts and the bounded YAML parser have independent reusable boundaries", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/skill-source-values.ts": await readFile(join(project, "apps/worker/src/contracts/skill-source-values.ts"), "utf8"),
    "apps/worker/src/contracts/skill-values.ts": await readFile(join(project, "apps/worker/src/contracts/skill-values.ts"), "utf8"),
    "apps/worker/src/contracts/capabilities.ts": await readFile(join(project, "apps/worker/src/contracts/capabilities.ts"), "utf8"),
    "apps/worker/src/contracts/identity.ts": await readFile(join(project, "apps/worker/src/contracts/identity.ts"), "utf8"),
    "apps/worker/src/contracts/skill-source.ts": 'export const SKILL_SOURCE_LIMITS = { directory_depth: 8 }; export interface SkillSource { repository: string; commit: string; path: string }',
    "apps/worker/src/domain/skills/frontmatter.ts": await readFile(join(project, "apps/worker/src/domain/skills/frontmatter.ts"), "utf8"),
    "apps/worker/src/domain/skills/bundle.ts": 'import { skillPath } from "../../contracts/skill-values.js"; import { skillFrontmatter } from "./frontmatter.js"; export const metadata = text => skillFrontmatter(text);',
    "apps/worker/src/application/skills/source.ts": 'import { parseSkillSource } from "../../contracts/skill-source-values.js"; import { metadata } from "../../domain/skills/bundle.js";',
    "apps/worker/src/platform/skills/github-source.ts": 'import { parseSkillSource } from "../../contracts/skill-source-values.js"; import { skillObject, skillPath } from "../../contracts/skill-values.js";',
    "apps/worker/src/http/central-skill-source.ts": 'import { parseSkillSource } from "../contracts/skill-source-values.js";',
  });
  const report = await checkArchitecture(f.root);
  assert.deepEqual(report.failures, []);
  assert.ok(report.edges.some(edge => edge.from === "apps/worker/src/platform/skills/github-source.ts"
    && edge.to === "apps/worker/src/contracts/skill-source-values.ts"));
  assert.ok(report.edges.filter(edge => edge.from.startsWith("apps/worker/src/contracts/")).every(edge => edge.to.startsWith("apps/worker/src/contracts/")));
});

test("Administrator session decisions are shared by HTTP and Central composition through a pure receipt contract", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/admin-session.ts": await readFile(join(project, "apps/worker/src/contracts/admin-session.ts"), "utf8"),
    "apps/worker/src/contracts/control-plane-receipts.ts": 'export interface JsonReceipt { status: number; value: unknown }',
    "apps/worker/src/http/session.ts": 'import { projectAdminSessionReceipt } from "../contracts/admin-session.js";',
    "apps/worker/src/capabilities-do.ts": 'import { projectAdminSessionReceipt } from "./contracts/admin-session.js";',
    "apps/worker/src/contracts/skills.ts": 'import type { AdminDecision } from "./admin-session.js";',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("Skill lifecycle values and receipt projection are shared through pure contracts", async t => {
  const sources = {};
  for (const name of ["skill-lifecycle", "skill-lifecycle-values", "skill-lifecycle-receipts", "skill-values", "skills", "identity"])
    sources[`apps/worker/src/contracts/${name}.ts`] = await readFile(join(project, `apps/worker/src/contracts/${name}.ts`), "utf8");
  Object.assign(sources, {
    "apps/worker/src/contracts/admin-session.ts": 'export type AdminDecision = { state: "allowed" };',
    "apps/worker/src/contracts/capabilities.ts": 'export type CapabilityTarget = { capability_id: string };',
    "apps/worker/src/contracts/skill-manifest.ts": 'export type SkillFileManifest = { path: string };',
    "apps/worker/src/http/central-skill-lifecycle.ts": 'import { projectSkillLifecycleReceipt } from "../contracts/skill-lifecycle-receipts.js";',
    "apps/worker/src/application/skills/lifecycle.ts": 'import { lifecycleInput } from "../../contracts/skill-lifecycle-values.js";',
    "apps/worker/src/platform/skills/lifecycle-store.ts": 'import { lifecycleRevision } from "../../contracts/skill-lifecycle-values.js";',
  });
  const f = await fixture(t, sources);
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("central API owns recovery while failure classification receives response values", async t => {
  const f = await fixture(t, {
    "apps/worker/browser/central/api.js": 'import { classifyCentralFailure } from "./failures.js"; export const classify = (...args) => classifyCentralFailure(...args);',
    "apps/worker/browser/central/failures.js": await readFile(join(project, "apps/worker/browser/central/failures.js"), "utf8"),
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("actual maintenance bundling rejects execution modules before emitting its artifact", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-maintenance-build-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const entry = join(root, "maintenance-entry.ts"), output = join(root, "maintenance.cjs");
  const source = name => JSON.stringify(join(project, "apps/runner/src", name).replaceAll("\\", "/"));
  await writeFile(entry, `export { serviceLayout } from ${source("service.ts")};\n`);
  await bundleRunner(entry, output);
  assert.ok((await stat(output)).size > 0);
  await writeFile(entry, `import ${source("cli.ts")};\nexport const manager = true;\n`);
  await assert.rejects(bundleRunner(entry, output), /Maintenance bundle includes .*apps\/runner\/src\//u);
  await assert.rejects(stat(output), { code: "ENOENT" });
});
for (const [name, sources] of bad) test(`AR01 rejects ${name}`, async t => {
  const f = await fixture(t, sources), result = await checkArchitecture(f.root);
  assert.ok(result.failures.length > 0, `${name} incorrectly passed`);
});

for (const [name, sources] of [
  ["dependency violation", { "packages/protocol/src/index.ts": 'import "node:fs";' }],
  ["source parse failure", { "apps/runner/src/a.ts": 'import {' }],
]) test(`architecture command reports ${name} with a failed exit status`, async t => {
  const f = await fixture(t, sources), result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Architecture check failed/);
  assert.equal(result.stdout, "");
});

test("request composition injects platform operations into application ports", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/receipts.ts": 'export type Receipt = { status: number; value: unknown }; export type Port = { read(): Promise<Receipt> };',
    "apps/worker/src/application/auth-source.mts": 'import type { Port } from "../contracts/receipts.js"; export const check = async (port: Port) => (await port.read()).status === 200;',
    "apps/worker/src/platform/source.ts": 'import type { Port } from "../contracts/receipts.js"; export const port: Port = { read: async () => ({ status: 200, value: {} }) };',
    "apps/worker/src/index.ts": 'import { check } from "./application/auth-source.mjs"; import { port } from "./platform/source.js"; export const result = () => check(port);',
  });
  const result = await f.run(); assert.equal(result.status, 0, result.stderr);
});

test("Registry release admission shares only the reviewed pure release rules", async t => {
  const f = await fixture(t, {
    "apps/worker/src/registry.ts": 'import { update } from "./registry/release-cache.js"; export const result = update(1);',
    "apps/worker/src/registry/release-cache.ts": 'import { validate } from "../domain/release-selection.js"; import type { Record } from "../contracts/runner-release.js"; export const update = (value: number): Record => validate(value);',
    "apps/worker/src/domain/release-selection.ts": 'export const validate = (value: number) => ({ value });',
    "apps/worker/src/contracts/runner-release.ts": 'export type Record = { value: number };',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("architecture rejects type-only cycles without confusing them with runtime cycles", async t => {
  const f = await fixture(t, {
    "packages/protocol/src/index.ts": 'export type { A } from "./a.js";',
    "packages/protocol/src/a.ts": 'import type { B } from "./b.js"; export type A = {b?: B};',
    "packages/protocol/src/b.ts": 'import { type A } from "./a.js"; export type B = {a?: A};',
    "apps/worker/src/a.ts": 'import type { A } from "@aloneio/runmesh-protocol"; export type C = A; type D = import("@aloneio/runmesh-protocol").A;',
    "apps/runner/src/a.ts": 'import { readFile } from "node:fs/promises"; void import("./b.js");',
    "apps/runner/src/b.ts": 'export const message = "import(unknownPath)"; // import "../../worker/src/a.js"',
  });
  const report = await checkArchitecture(f.root);
  assert.equal(report.runtimeCycles.length, 0); assert.equal(report.typeCycles.length, 1);
  assert.ok(report.failures.some(value => value.includes("type-inclusive dependency cycle")));
  assert.equal((await f.run()).status, 1);
});

test("W01 composition injects central public ports without widening native dependencies", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/capabilities.ts": 'export type Port = { read(id: string): Promise<string> };',
    "apps/worker/src/domain/capabilities/grants.ts": 'export const enabled = (value: boolean) => value;',
    "apps/worker/src/application/capabilities/access.ts": 'import type { Port } from "../../contracts/capabilities.js"; import { enabled } from "../../domain/capabilities/grants.js"; export const create = (port: Port) => port;',
    "apps/worker/src/platform/capabilities/owner.ts": 'import "cloudflare:workers"; import type { Port } from "../../contracts/capabilities.js"; export type Adapter = Port;',
    "apps/worker/src/http/central.ts": 'import { create } from "../application/capabilities/access.js"; import "../platform/capabilities/owner.js";',
    "apps/worker/src/mcp/providers/remote.ts": 'import type { Port } from "../../contracts/capabilities.js"; import "./remote/helper.js"; import "./schema-publication.js"; export const bind = (port: Port) => port;',
    "apps/worker/src/mcp/providers/remote/helper.ts": 'import type { McpServer } from "@modelcontextprotocol/server"; import type { ZodType } from "zod"; export type { Port } from "../../../contracts/capabilities.js";',
    "apps/worker/src/mcp/providers/skills.mts": 'export * from "./skills/helper.mjs"; import "./schema-publication.js";',
    "apps/worker/src/mcp/providers/schema-publication.ts": 'import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server"; export type Schema = StandardSchemaWithJSON;',
    "apps/worker/src/mcp/providers/skills/helper.mts": 'import type { Port } from "../../../contracts/capabilities.js"; export type Input = Port;',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("AR01 side-effect imports are runtime edges, not type-only edges", async t => {
  const f = await fixture(t, { "apps/runner/src/a.ts": 'import {} from "./b.js";', "apps/runner/src/b.ts": 'export * from "./a.js";' });
  assert.equal((await f.run()).status, 1);
});

test("AR01 build gates are required in both hosted CI definitions and parity checking", async () => {
  for (const path of [".github/workflows/ci.yml", ".gitlab-ci.yml"])
    assert.ok((await readFile(join(project, path), "utf8")).includes(checkCommand("architecture")), `${path} omits the architecture gate`);
  assert.ok((await readFile(join(project, "scripts/check-ci-parity.mjs"), "utf8")).includes("validateCiWiring"), "parity checker must validate the parsed CI contract");
});

test("AR01 source symlinks cannot silently bypass module discovery", async t => {
  const f = await fixture(t, { "outside.ts": "export {};" });
  try { await symlink(join(f.root, "outside.ts"), join(f.root, "packages/protocol/src/alias.ts")); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.skip("Host does not grant file symlink creation"); throw error; }
  assert.equal((await f.run()).status, 1);
});

test("AR03 narrow contracts and platform types need no concrete adapter dependency", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/selection.ts": "export type Selection = {id: string};",
    "apps/worker/src/platform/env.ts": "export interface Env { readonly name: string }",
    "apps/worker/src/public-origin.ts": "export const canonical = (value: string) => new URL(value).origin;",
    "apps/worker/src/runtime-config.ts": 'import { canonical } from "./public-origin.js"; export const value=canonical;',
    "apps/worker/src/mcp/server.ts": 'import type { Selection } from "../contracts/selection.js"; import type { Env } from "../platform/env.js"; export type Input = [Selection, Env];',
  });
  const result = await f.run(); assert.equal(result.status, 0, result.stderr);
});

for (const extension of ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"]) {
  test(`AR09 platform boundaries include ${extension} modules and type imports`, async t => {
    const f = await fixture(t, {
      [`apps/worker/src/domain/new-rule.${extension}`]: 'import "cloudflare:workers";',
      [`apps/runner/src/jobs/new-planner.${extension}`]: 'import "dgram";',
    });
    const report = await checkArchitecture(f.root);
    assert.ok(report.failures.some(value => value.includes("Cloudflare platform")));
    assert.ok(report.failures.some(value => value.includes("record and planning")));
  });
}
for (const specifier of ["fs/promises", "node:fs/promises", "dgram", "dns/promises", "node:test", "timers/promises", "ws"]) {
  test(`AR09 newly named planners reject ${specifier}`, async t => {
    const f = await fixture(t, { "apps/runner/src/context/pure/renamed.ts": `import "${specifier}";` });
    assert.notEqual((await checkArchitecture(f.root)).failures.length, 0);
  });
}
test("AR09 pure Worker roles reject external platform types and renamed barrels", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/renamed.mts": 'import type { DurableObject } from "cloudflare:workers";',
    "apps/worker/src/domain/rules.ts": 'export * from "./new-wrapper.js";',
    "apps/worker/src/domain/new-wrapper.ts": 'export * from "@cloudflare/workers-types";',
    "apps/worker/browser/view.js": 'import "@modelcontextprotocol/server";',
    "apps/runner/src/jobs/ports.ts": 'import "fs";',
  });
  const report = await checkArchitecture(f.root);
  for (const name of ["renamed.mts", "new-wrapper.ts", "view.js", "ports.ts"]) assert.ok(report.failures.some(value => value.includes(name)), name);
});
test("AR09 reviewed adapters, pure hashing and platform type ports remain legal", async t => {
  const f = await fixture(t, {
    "apps/worker/src/platform/native.ts": 'import "cloudflare:workers";',
    "apps/worker/src/mcp/sdk.ts": 'import "@modelcontextprotocol/server";',
    "apps/runner/src/jobs/pure/fingerprint.mts": 'import { createHash } from "node:crypto";',
    "apps/runner/src/jobs/ports.ts": 'import type { FileHandle } from "fs/promises";',
    "apps/runner/src/jobs/storage.ts": 'import "node:fs/promises";',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

for (const [from,to] of [
  ["connection/ports.ts","runtime.ts"], ["connection/policy-candidate.ts","connection.ts"],
  ["connection/job-events.ts","jobs.ts"], ["jobs/retention-plan.ts","jobs/storage.ts"],
]) test(`AR10/AR13 rejects ${from} importing ${to}`,async t=>{
  const prefix="apps/runner/src/", parts=from.split("/").length-1;
  const f=await fixture(t,{[prefix+from]:`import type { State } from "${"../".repeat(parts)}${to.replace(/\.ts$/u,".js")}";`,[prefix+to]:"export type State = {};"});
  assert.notEqual((await checkArchitecture(f.root)).failures.length,0);
});

test("AR10 connection ports may reference WebSocket types but cannot load ws",async t=>{
  const legal=await fixture(t,{"apps/runner/src/connection/ports.ts":'import type WebSocket from "ws";'});
  assert.deepEqual((await checkArchitecture(legal.root)).failures,[]);
  const illegal=await fixture(t,{"apps/runner/src/connection/ports.ts":'import WebSocket from "ws";'});
  assert.ok((await checkArchitecture(illegal.root)).failures.some(value=>value.includes("Connection ports")));
});


for (const [name, sources] of [
  ["Patch parser filesystem", { "apps/runner/src/patch/parse.ts": 'import "node:fs/promises";' }],
  ["Patch renderer bare filesystem", { "apps/runner/src/patch/preview.ts": 'import "fs/promises";' }],
  ["renamed Patch TypeScript module", { "apps/runner/src/patch/new-planner.mts": 'export * from "node:child_process";' }],
  ["nested Patch JSX module", { "apps/runner/src/patch/nested/view.tsx": 'import type { Stats } from "node:fs";' }],
  ["Connection failure network", { "apps/runner/src/connection/failures.ts": 'import "node:net";' }],
  ["Connection Job projection SDK", { "apps/runner/src/connection/job-events.ts": 'import "ws";' }],
  ["new Connection module", { "apps/runner/src/connection/new.cjs": 'require("node:fs");' }],
  ["Patch type through concrete resolver", { "apps/runner/src/patch/contracts.ts": 'import type { T } from "../path-policy.js";', "apps/runner/src/path-policy.ts": 'export type T = string;' }],
  ["Patch intermediary", { "apps/runner/src/patch/parse.ts": 'export * from "./renamed.js";', "apps/runner/src/patch/renamed.ts": 'import "node:fs";' }],
  ["Patch barrel to adapter", { "apps/runner/src/patch/parse.ts": 'export * from "./barrel.js";', "apps/runner/src/patch/barrel.ts": 'export * from "./files.js";', "apps/runner/src/patch/files.ts": 'export {};' }],
  ["release core to installer", { "apps/worker/src/distribution/release.ts": 'import "../installer.js";', "apps/worker/src/installer.ts": 'export {};' }],
  ["release model to network adapter", { "apps/worker/src/domain/release-selection.ts": 'import "../distribution/release-io.js";', "apps/worker/src/distribution/release-io.ts": 'export {};' }],
]) test(`AR15/AR17 rejects ${name}`, async t => {
  const f = await fixture(t, sources);
  const result = await checkArchitecture(f.root);
  assert.ok(result.failures.length > 0, `${name} incorrectly passed`);
});

test("AR17 preserves reviewed Patch adapters, pure hash/path helpers and data contracts", async t => {
  const f = await fixture(t, {
    "apps/runner/src/patch/files.ts": 'import "node:fs/promises"; import "./contracts.js";',
    "apps/runner/src/patch/preview.ts": 'import "node:crypto"; import "node:path"; import type { P } from "./contracts.js";',
    "apps/runner/src/patch/contracts.ts": 'export type { P } from "../path-contracts.js";',
    "apps/runner/src/path-contracts.ts": 'export type P = { readonly path: string };',
    "apps/runner/src/connection/policy-candidate.ts": 'import "node:fs/promises";',
    "apps/runner/src/connection/ports.ts": 'import type WebSocket from "ws";',
    "apps/runner/src/connection/failures.ts": 'export const classify = (code: number) => code === 401;',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});


test("AR18 prevents retired private I/O mocks from returning", async () => {
  function visit(node, callback) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child, callback); return; }
    callback(node);
    for (const [key, child] of Object.entries(node)) if (!["loc", "start", "end", "extra", "comments"].includes(key)) visit(child, callback);
  }
  const parseTest = source => parse(source, { sourceType: "module", plugins: ["typescript"] });
  const property = node => node?.computed ? node.property?.value : node?.property?.name;
  const connectionPrivateAccesses = source => {
    const violations = [];
    const retired = new Set(["applyDesiredPolicy", "forwardJobEvent", "historyPending", "welcomedSocket", "sendSyncNow", "lastSyncSnapshot", "syncTimer", "desiredPolicyRevision", "desiredPolicyChecksum", "appliedPolicyRevision", "appliedPolicyChecksum"]);
    const unwrap = node => ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression"].includes(node?.type) ? unwrap(node.expression) : node;
    visit(parseTest(source), node => {
      if (["TSAsExpression", "TSTypeAssertion"].includes(node.type) && unwrap(node)?.name === "connection") violations.push("connection assertion");
      if (node.type === "MemberExpression" && (retired.has(property(node))
        || unwrap(node.object)?.name === "connection" && !["start", "stop", "rpc", "disconnectTransport"].includes(property(node)))) violations.push(property(node));
    });
    return violations;
  };
  assert.deepEqual(connectionPrivateAccesses("connection.start(); fixture.socket.open(); socket.send(frame);"), []);
  for (const source of ["(connection as unknown as State).socket = socket;", "connection['metadata'];", "internals.applyDesiredPolicy(socket, policy);", "internals['historyPending'] = pending;"]) {
    assert.ok(connectionPrivateAccesses(source).length > 0, "private connection fixture must be rejected");
  }
  for (const name of ["connection-handshake", "connection-budgets", "connection-outage", "product"]) {
    const source = await readFile(join(project, "apps/runner/test/" + name + ".test.ts"), "utf8");
    assert.deepEqual(connectionPrivateAccesses(source), [], name + ": exercise connection lifecycle and injected ports instead of private state");
  }
  for (const name of ["packed-job-integration", "no-record", "transport", "quota-resilience"]) {
    const source = await readFile(join(project, 'apps/worker/test/' + name + '.test.ts'), "utf8");
    visit(parseTest(source), node => {
      if (node.type === "MemberExpression") assert.ok(!["ctx", "packedJobs", "externalAudit", "schemaIsCurrent"].includes(property(node)),
        name + ": use constructor bindings, public storage fixtures and the schema module");
      if (node.type === "AssignmentExpression") assert.notEqual(property(node.left), "env", name + ": construct the Registry with its environment");
    });
  }
  for (const name of ["concurrency", "enrollment-fence-recovery", "job-reporting-bridge"]) {
    const source = await readFile(join(project, `apps/worker/test/${name}.test.ts`), "utf8");
    visit(parseTest(source), node => {
      if (node.type === "AssignmentExpression") assert.notEqual(property(node.left), "registryRequest", `${name}: use the injected RegistryRequestPort`);
    });
  }
  const runtime = parseTest(await readFile(join(project, "apps/runner/test/runtime.test.ts"), "utf8"));
  visit(runtime, node => {
    if (node.type !== "CallExpression" || node.arguments[0]?.type !== "StringLiteral"
      || !(node.callee?.name === "it" || node.callee?.type === "CallExpression" && node.callee.callee?.object?.name === "it")) return;
    const name = node.arguments[0].value;
    visit(node.arguments[1], child => {
      if (child.type === "TSAsExpression" && child.expression?.type === "TSAsExpression" && child.expression.typeAnnotation?.type === "TSUnknownKeyword")
        assert.fail(name + ": do not cast JobManager to a private-state test interface");
      if (child.type === "MemberExpression") {
        const owner = child.object?.type === "TSNonNullExpression" ? child.object.expression?.name : child.object?.name;
        assert.ok(!["jobDir", "closeLogHandles", "queueLogAppend", "logWriteChain", "finish", "flushLogs", "pruneRetainedJobsNow", "cancelRecoveredUnknown", "reconcileRecoveredJob"].includes(property(child))
          && !["persist", "enqueuePersistence"].includes(property(child))
          && (property(child) !== "jobs" || owner === "runtime")
          && (property(child) !== "processes" || owner === "probe"),
          name + ": use persisted fixtures and supported ports rather than private JobManager state");
      }
    });
  });
});

test("stdin delivery accepts stream types without broadening planner permissions", async () => {
  const { specifierProblem } = await import("../scripts/architecture-policy.mjs");
  assert.equal(specifierProblem("apps/runner/src/jobs/input.ts", "node:stream", true), undefined);
  assert.ok(specifierProblem("apps/runner/src/jobs/records.ts", "node:stream", true));
});
