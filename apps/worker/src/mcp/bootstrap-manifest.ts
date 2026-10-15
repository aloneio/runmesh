import { PRODUCT_VERSION } from "../generated-version.js";
import { sha256Hex } from "../security.js";

export const BOOTSTRAP_SCHEMA_VERSION = 1 as const;
export const BOOTSTRAP_MANIFEST_REVISION = 2 as const;
export const BOOTSTRAP_REMOTE_PROFILE_LIMIT = 16;

const runtimeAuthorization = () => Object.freeze({ supported: true, authorization: "runtime" as const });

const STATIC_CONTRACT = Object.freeze({
  schema_version: BOOTSTRAP_SCHEMA_VERSION,
  product: {
    name: "RunMesh" as const,
    purpose: "Remote machines, workspaces, jobs, handoff context, reusable Skills, and federated MCP services.",
  },
  usage: {
    recommended_call: "once_per_session_or_manifest_change" as const,
    cache_key: "manifest.sha256" as const,
    full_remote_schemas_included: false as const,
  },
  capabilities: {
    runners: runtimeAuthorization(),
    workspaces: runtimeAuthorization(),
    read: runtimeAuthorization(),
    edit: runtimeAuthorization(),
    shell: runtimeAuthorization(),
    jobs: runtimeAuthorization(),
    context: runtimeAuthorization(),
    skills: runtimeAuthorization(),
    remote_mcp: runtimeAuthorization(),
  },
  routing: {
    machine_operations: {
      start_with: "runner_list" as const,
      select_with: "runner_select" as const,
      workspaces_with: "workspace_list" as const,
    },
    workspace_operations: {
      inspect_with: "inspect" as const,
      read_with: "read" as const,
      edit_with: "edit" as const,
    },
    long_running_operations: {
      start_with: "shell" as const,
      continue_with: "job" as const,
    },
    external_services: {
      strategy: "search_then_profile_fallback_then_call" as const,
      list_services: "remote_profiles" as const,
      search: "remote_search" as const,
      load_schema: "remote_tools" as const,
      invoke: "remote_call" as const,
      fallback: {
        when_search_returns_no_relevant_tools: "inspect_profile_tools_before_unavailable" as const,
        known_service: "remote_tools" as const,
        unknown_service: "remote_profiles_then_remote_tools" as const,
      },
    },
    reusable_workflows: {
      list: "skill_list" as const,
      read: "skill_read" as const,
    },
    handoff_context: {
      tool: "context" as const,
      bootstrap_action: "bootstrap" as const,
    },
  },
  authorization: {
    source: "runtime" as const,
    bootstrap_grants_permissions: false as const,
  },
  rules: [
    "Do not assume a remote service or tool is unavailable before discovery.",
    "If remote_search returns no relevant tools, inspect the known service with remote_tools, or use remote_profiles then remote_tools, before concluding the capability is unavailable.",
    "Load remote tool schemas only when relevant to the current task.",
    "Prefer inspection before mutation.",
    "Do not blindly retry writes or commands with an uncertain outcome.",
    "Continue existing jobs with job instead of relaunching the command.",
    "Bootstrap describes capabilities and routing but never grants permissions.",
  ] as const,
});

export type BootstrapDirectoryState = "ready" | "empty" | "disabled" | "unavailable";
export type BootstrapRunnerSelection = "none" | "selected" | "unavailable";
export type BootstrapRunnerState = "online" | "offline" | "stale" | "unavailable";

export interface BootstrapRuntimeSnapshot {
  readonly runner: {
    readonly selection: BootstrapRunnerSelection;
    readonly state: BootstrapRunnerState | null;
    readonly available: boolean;
  };
  readonly remote_mcp: {
    readonly state: BootstrapDirectoryState;
    readonly profiles?: readonly { readonly profile_id: string; readonly name: string }[];
    readonly profile_count?: number;
  };
  readonly skills: {
    readonly state: BootstrapDirectoryState;
    readonly page_count?: number;
    readonly has_more?: boolean;
  };
}

export async function buildBootstrapManifest(snapshot: BootstrapRuntimeSnapshot) {
  const contractDigest = await sha256Hex(JSON.stringify(STATIC_CONTRACT));
  const profiles = snapshot.remote_mcp.profiles?.slice(0, BOOTSTRAP_REMOTE_PROFILE_LIMIT);
  const profileCount = snapshot.remote_mcp.profile_count;
  return {
    ...STATIC_CONTRACT,
    product: { ...STATIC_CONTRACT.product, version: PRODUCT_VERSION },
    current: { runner: snapshot.runner },
    directory: {
      remote_mcp: {
        state: snapshot.remote_mcp.state,
        discover_with: "remote_search" as const,
        ...(profileCount === undefined ? {} : { profile_count: profileCount }),
        ...(profiles === undefined ? {} : { profiles }),
        ...(profileCount === undefined ? {} : { profiles_truncated: profileCount > (profiles?.length ?? 0) }),
      },
      skills: {
        state: snapshot.skills.state,
        discover_with: "skill_list" as const,
        ...(snapshot.skills.page_count === undefined ? {} : { page_count: snapshot.skills.page_count }),
        ...(snapshot.skills.has_more === undefined ? {} : { has_more: snapshot.skills.has_more }),
      },
    },
    manifest: {
      revision: BOOTSTRAP_MANIFEST_REVISION,
      sha256: contractDigest,
      digest_scope: "static_contract" as const,
    },
  };
}

export const bootstrapStaticContractForTest = STATIC_CONTRACT;
