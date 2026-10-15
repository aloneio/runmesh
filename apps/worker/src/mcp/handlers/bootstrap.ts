import type { SharedProfiles } from "../../contracts/catalog.js";
import type { CentralRemote } from "../../contracts/remote.js";
import type { CentralSkills, SkillPage } from "../../contracts/skills.js";
import type { McpClientActiveRunner } from "../../contracts/runner-selection.js";
import type { McpRequestEnv } from "../contracts.js";
import { buildBootstrapManifest, type BootstrapRuntimeSnapshot } from "../bootstrap-manifest.js";
import { success } from "../results/envelope.js";
import { getActiveRunnerSelection } from "../selection.js";

const DIRECTORY_TIMEOUT_MS = 2_000;

async function bounded<T>(call: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), DIRECTORY_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function runnerSnapshot(value: unknown): BootstrapRuntimeSnapshot["runner"] {
  const selection = value as McpClientActiveRunner;
  if (selection.active_runner_id === null) return { selection: "none", state: null, available: false };
  const state = selection.runner?.state;
  if (state !== "online" && state !== "offline" && state !== "stale" && state !== "unavailable") {
    return { selection: "unavailable", state: null, available: false };
  }
  return { selection: "selected", state, available: state === "online" };
}

function remoteSnapshot(value: SharedProfiles | undefined): BootstrapRuntimeSnapshot["remote_mcp"] {
  if (value?.state !== "listed") return { state: "unavailable" };
  return {
    state: value.profiles.length === 0 ? "empty" : "ready",
    profile_count: value.profiles.length,
    profiles: value.profiles.map(profile => ({ profile_id: profile.profile_id, name: profile.name })),
  };
}

function skillSnapshot(value: SkillPage | undefined): BootstrapRuntimeSnapshot["skills"] {
  if (value?.state !== "listed") return { state: "unavailable" };
  return {
    state: value.skills.length === 0 && value.next_after === null ? "empty" : "ready",
    page_count: value.skills.length,
    has_more: value.next_after !== null,
  };
}

export async function bootstrapTool(env: McpRequestEnv, clientId: string): Promise<unknown> {
  const selected = await getActiveRunnerSelection(env, clientId);
  const runner = selected.ok ? runnerSnapshot(selected.value) : { selection: "unavailable" as const, state: null, available: false };

  let remote_mcp: BootstrapRuntimeSnapshot["remote_mcp"] = { state: "disabled" };
  let skills: BootstrapRuntimeSnapshot["skills"] = { state: env.CENTRAL_SKILLS_ENABLED === "1" ? "unavailable" : "disabled" };
  if (env.CAPABILITIES !== undefined) {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CentralRemote & CentralSkills;
    const secretVersion = env.mcpPrincipal.secret_version;
    if (typeof secretVersion !== "number" || !Number.isSafeInteger(secretVersion) || secretVersion < 1) {
      return success(await buildBootstrapManifest({ runner, remote_mcp: { state: "unavailable" }, skills }));
    }
    const principal = { client_id: env.mcpPrincipal.client_id, secret_version: secretVersion };
    const [profiles, skillPage] = await Promise.all([
      bounded(() => owner.listRemoteProfiles(principal)),
      env.CENTRAL_SKILLS_ENABLED === "1" ? bounded(() => owner.listSkills(principal, {})) : Promise.resolve(undefined),
    ]);
    remote_mcp = remoteSnapshot(profiles);
    if (env.CENTRAL_SKILLS_ENABLED === "1") skills = skillSnapshot(skillPage);
  }

  return success(await buildBootstrapManifest({ runner, remote_mcp, skills }));
}
