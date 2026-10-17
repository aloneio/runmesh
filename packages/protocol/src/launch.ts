import { canonicalJson } from "./hash.js";

export interface LaunchDigestInputs {
  readonly canonical: string;
  readonly legacy: string;
}

/**
 * Normalize the authenticated launch fields once for both Worker and Runner.
 * Unknown transport fields are intentionally ignored so the digest remains a
 * stable execution contract rather than a hash of the whole RPC envelope.
 */
export function normalizedLaunchInput(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    workspace_id: params.workspace_id,
    command: params.command,
    args: params.args ?? null,
    shell: params.shell,
    cwd: params.cwd ?? ".",
    request_id: params.request_id ?? null,
    ...(typeof params.record_history === "boolean" ? { record_history: params.record_history } : {}),
  })) as Record<string, unknown>;
}

export function launchDigestInputs(params: Record<string, unknown>): LaunchDigestInputs {
  const input = normalizedLaunchInput(params);
  return { canonical: canonicalJson(input), legacy: JSON.stringify(input) };
}
