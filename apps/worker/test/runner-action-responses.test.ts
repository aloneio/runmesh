import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { handleBrowserAdmin } from "../src/http/admin.js";
import { handleBrowserRunnerAction } from "../src/http/runner-actions.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { sha256Hex } from "../src/security.js";

// This suite owns response disposal; release authenticity is exercised by the release and update-admin suites.
vi.mock("../src/distribution/exact-release.js", () => ({ resolveExactRunnerRelease: vi.fn(async (version: string) => ({
  package_version: version, manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64),
})) }));

const actions = ["permissions", "emergency-lock", "workspace-create", "workspace-update", "workspace-delete", "rename", "validity", "version-policy"] as const;

function fixture(status = 200, onCancel: () => void | Promise<void> = () => undefined) {
  const mutations: Response[] = [];
  let cancelled = 0;
  const localEnv = { ...env, RUNMESH_PUBLIC_ORIGIN: "https://console.invalid",
    RUNNER: { idFromName: () => "runner", get: () => ({ fetch: () => new Response(null, { status: 204 }) }) },
    REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/auth/sessions/verify") return Response.json({ csrf_hash: await sha256Hex("c".repeat(43)) });
      if (path.endsWith("/execution-state")) return Response.json({ runner: { runner_id: "r" }, lifecycle_id: "lifecycle" });
      if (path.endsWith("/mutation-state")) return Response.json({ mutation_committed: true,
        policy_status: "offline_pending", desired_revision: 1, desired_checksum: "a".repeat(64) });
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("committed receipt")); },
        cancel() { cancelled++; return onCancel(); },
      }), { status });
      mutations.push(response);
      return response;
    } }) },
  } as unknown as typeof env;
  return { localEnv, mutations, cancelled: () => cancelled,
    async cleanup() { await Promise.all(mutations.map(response => response.body?.cancel().catch(() => undefined))); } };
}

function actionForm(action: typeof actions[number]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({ read: "true", edit: "true", shell: "true", job_control: "true",
    workspace_id: "w", display_name: "Workspace", root_path: "/workspace", enabled: "true", profile: "coding",
    operation_id: "receipt-operation", update_channel: "pinned", desired_runner_version: "0.1.6", confirmation: action === "workspace-delete" ? "w" : "r" })) form.set(key, value);
  return form;
}

it.each(actions)("releases the successful %s receipt when redirecting the browser", async action => {
  const f = fixture();
  try {
    const result = await handleBrowserRunnerAction(f.localEnv, actionForm(action), "https://console.invalid", "r", action);
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(action === "rename" ? "/admin" : "/admin/runners/r");
    expect(result.body).toBeNull();
    expect(f.mutations).toHaveLength(1);
    expect(f.cancelled()).toBe(1);
  } finally { await f.cleanup(); }
});

it.each([200, 404, 503])("releases the history-settings receipt for HTTP %s", async status => {
  const f = fixture(status);
  try {
    const url = new URL("https://console.invalid/admin/runners/r/history-settings");
    const request = new Request(url, { method: "POST", headers: { origin: url.origin,
      cookie: `${ADMIN_SESSION_COOKIE}=${"s".repeat(43)}; ${ADMIN_CSRF_COOKIE}=${"c".repeat(43)}` },
      body: new URLSearchParams({ csrf_token: "c".repeat(43), mode: "immediate", interval_seconds: "300", retention_days: "7", local_retention_days: "0" }) });
    const result = await handleBrowserAdmin(request, f.localEnv, url);
    expect(result.status).toBe(status === 200 ? 303 : status);
    expect(f.mutations).toHaveLength(1);
    expect(f.cancelled()).toBe(1);
    await result.body?.cancel();
  } finally { await f.cleanup(); }
});

it.each(["pending", "rejected"] as const)("does not replay a committed workspace change or wait for %s receipt cleanup", async cleanup => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(200, () => cleanup === "pending" ? gate : Promise.reject(new Error("cleanup unavailable")));
  try {
    const result = await handleBrowserRunnerAction(f.localEnv, actionForm("workspace-create"), "https://console.invalid", "r", "workspace-create");
    expect(result.status).toBe(303);
    expect(f.mutations).toHaveLength(1);
    expect(f.cancelled()).toBe(1);
  } finally { release(); await f.cleanup(); }
}, 2_000);
