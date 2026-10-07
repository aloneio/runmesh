import { env, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, type RunnerMetadata } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";

it("repeated policy acknowledgements write only changed workspace validation states", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`policy-cost-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), id = "cost-runner", permissions = { read: true, edit: true, shell: true, job_control: true };
    instance.registerRunner(id, "a".repeat(64), now, undefined, "dedicated_user");
    for (let index = 0; index < 64; index++) instance.createManagedWorkspace(id, { workspace_id: `w${index}`, display_name: `Workspace ${index}`, root_path: `/workspace/${index}`, enabled: true, permissions }, now);
    const before = instance.getRunnerExecutionState(id)!;
    const desired = instance.getDesiredPolicySnapshot(id)!;
    const metadata: RunnerMetadata = { runner_id: id, runner_version: "0.1.7", platform: "linux", architecture: "x64", capabilities: {
      filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
      max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } };
    const protocols = { min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION };
    const epoch = instance.beginConnection(id, metadata, protocols, "session", before.runner.credential_version, now, before.lifecycle_id)!;
    const input = { desired_revision: desired.revision, desired_checksum: desired.checksum, applied_revision: desired.revision, applied_checksum: desired.checksum,
      runner_reported_policy_revision: desired.revision, runner_reported_policy_checksum: desired.checksum, status: "applied" as const,
      workspace_status: desired.workspaces.map(workspace => ({ workspace_id: workspace.workspace_id, status: "valid" as const })) };
    let workspaceWrites = 0, totalWrites = 0;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      const cursor = exec(query, ...args); totalWrites += cursor.rowsWritten;
      if (query.startsWith("UPDATE managed_workspaces SET validation_status")) workspaceWrites += cursor.rowsWritten;
      return cursor;
    });
    const reset = () => { workspaceWrites = 0; totalWrites = 0; };
    try {
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, input, now, before.lifecycle_id, "session")).toBe("applied");
      expect(workspaceWrites).toBe(64);
      reset();
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, input, now + 1, before.lifecycle_id, "session")).toBe("applied");
      expect(workspaceWrites).toBe(0);
      expect(totalWrites).toBe(2);
      expect(state.storage.sql.exec("SELECT policy_acked_at_ms FROM runners WHERE runner_id=?", id).one().policy_acked_at_ms).toBe(now + 1);
      expect(state.storage.sql.exec("SELECT acknowledged_at_ms FROM runner_policy_versions WHERE runner_id=? AND revision=?", id, desired.revision).one().acknowledged_at_ms).toBe(now + 1);
      console.log(JSON.stringify({ scenario: "unchanged_policy_ack_64_workspaces", workspace_rows_written: workspaceWrites, total_rows_written: totalWrites }));

      const changed = { ...input, status: "invalid" as const, workspace_status: input.workspace_status.map((item, index) => index === 0 ? { ...item, status: "invalid_path" as const } : item) };
      reset();
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, changed, now + 2, before.lifecycle_id, "session")).toBe("invalid");
      expect(workspaceWrites).toBe(1);
      expect(instance.getManagedWorkspace(id, changed.workspace_status[0]!.workspace_id)?.validation_status).toBe("invalid_path");
      reset();
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, changed, now + 3, before.lifecycle_id, "session")).toBe("invalid");
      expect(workspaceWrites).toBe(0);
      reset();
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, input, now + 4, before.lifecycle_id, "session")).toBe("applied");
      expect(workspaceWrites).toBe(1);

      const replacementEpoch = instance.beginConnection(id, metadata, protocols, "replacement", before.runner.credential_version, now + 5, before.lifecycle_id)!;
      reset();
      expect(instance.acknowledgePolicy(id, epoch, before.runner.credential_version, changed, now + 6, before.lifecycle_id, "session")).toBeUndefined();
      expect(totalWrites).toBe(0);
      expect(instance.acknowledgePolicy(id, replacementEpoch, before.runner.credential_version, input, now + 7, before.lifecycle_id, "replacement")).toBe("applied");
      expect(workspaceWrites).toBe(0);
      expect(totalWrites).toBe(2);
    } finally { spy.mockRestore(); }
  });
});
