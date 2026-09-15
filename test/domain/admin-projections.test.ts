import { expect, it } from "vitest";
import { runnerSummary, clientSummary, runnerDetail, clientDetail } from "../../apps/worker/src/application/admin-projections.js";
import type { RunnerSummaryViewModel, ClientViewModel } from "../../apps/worker/src/contracts/admin-views.js";
it("Runner summary selects display fields instead of spreading a record", () => {
  const view: RunnerSummaryViewModel = { runner_id: "r", display_name: "Delete", state: "online", last_heartbeat_ms: 0, configured_execution_mode: "dedicated_user", public_info: { platform: "linux", architecture: "arm64" }, active_job_count: 2 };
  const internal = { ...view, token_verifier: "never-display", lifecycle_id: "private", root_path: "/private" };
  expect(runnerSummary(internal)).toEqual(view); expect(JSON.stringify(runnerSummary(internal))).not.toContain("private");
});
it("Client projection preserves opaque labels and does not expose credentials", () => {
  const view: ClientViewModel = { client_id: "c", label: "Delete", scopes: ["coding:read"], revoked_at_ms: null, last_used_at_ms: null, active_runner_id: null, record_jobs: false };
  const internal = { ...view, secret_verifier: "private", password: "private" };
  expect(clientSummary(internal)).toEqual(view); expect(clientSummary(internal).scopes).not.toBe(view.scopes);
  expect(clientDetail(internal)).not.toHaveProperty("secret_verifier");
  expect(runnerDetail({ runner_id: "r", token_verifier: "private", session_id: "private" })).toEqual({ runner_id: "r" });
});
