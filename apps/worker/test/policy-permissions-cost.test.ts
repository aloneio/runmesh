import { env, runInDurableObject } from "cloudflare:test";
import { runnerPolicyChecksum, type RunnerPolicy } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import type { RegistryDO } from "../src/registry.js";

const full = { read: true, edit: true, shell: true, job_control: true };
const readonly = { read: true, edit: false, shell: false, job_control: false };

function seed(instance: RegistryDO, state: DurableObjectState, count = 4): RunnerPolicy {
  const now = Date.now();
  instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
  instance.createMcpClient({ client_id: "c", label: "Permission cost fixture", secret_verifier: "b".repeat(64),
    secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now);
  const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: { ...full },
    workspaces: Array.from({ length: count }, (_, index) => ({ workspace_id: `w${index}`, root_path: `/workspace/${index}`,
      enabled: true, permissions: { ...full } })) };
  const policy = { ...raw, checksum: runnerPolicyChecksum(raw) };
  storePolicy(state, policy);
  return policy;
}

function storePolicy(state: DurableObjectState, policy: RunnerPolicy): void {
  state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=?, checksum=?, status='applied' WHERE runner_id='r' AND revision=1", JSON.stringify(policy), policy.checksum);
  state.storage.sql.exec("UPDATE runners SET desired_policy_revision=1, applied_policy_revision=1, runner_reported_policy_revision=1, desired_policy_checksum=?, active_policy_checksum=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id='r'", policy.checksum, policy.checksum, policy.checksum);
}

function ready(instance: RegistryDO, state: DurableObjectState, count = 4): RunnerPolicy {
  const policy = seed(instance, state, count);
  state.storage.sql.exec("UPDATE runners SET state='online', connection_epoch=1, session_id='readiness-session' WHERE runner_id='r'");
  return policy;
}

it.each([1, 64])("policy readiness reads one current Runner and one policy with %i workspaces", async count => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`readiness-cost-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const policy = ready(instance, state, count);
    const expected = instance.getPolicyReadiness("r");
    expect(expected).toMatchObject({ ok: true, applied_revision: 1, active_checksum: policy.checksum, session_id: "readiness-session" });
    const cursors: Array<{ readonly rowsRead: number; readonly rowsWritten: number }> = [];
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      const cursor = exec(query, ...args); cursors.push(cursor); return cursor;
    });
    try { for (let n = 0; n < 20; n++) expect(instance.getPolicyReadiness("r")).toEqual(expected); }
    finally { spy.mockRestore(); }
    const reads = cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
    const writes = cursors.reduce((total, cursor) => total + cursor.rowsWritten, 0);
    console.log(JSON.stringify({ scenario: "policy_readiness_20", workspaces: count, queries: cursors.length, rows_read: reads, rows_written: writes }));
    expect({ calls: cursors.length, reads, writes }).toEqual({ calls: 40, reads: 40, writes: 0 });
  });
});

it.each(["offline", "desired-version", "missing-snapshot", "unapplied-snapshot", "malformed-snapshot", "changed-content"] as const)(
  "policy readiness revalidates a subsequent %s change", async change => {
    const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`readiness-fresh-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (instance, state) => {
      const policy = ready(instance, state);
      expect(instance.getPolicyReadiness("r").ok).toBe(true);
      if (change === "offline") state.storage.sql.exec("UPDATE runners SET state='offline' WHERE runner_id='r'");
      else if (change === "desired-version") state.storage.sql.exec("UPDATE runners SET desired_policy_revision=2 WHERE runner_id='r'");
      else if (change === "missing-snapshot") state.storage.sql.exec("DELETE FROM runner_policy_versions WHERE runner_id='r' AND revision=1");
      else if (change === "unapplied-snapshot") state.storage.sql.exec("UPDATE runner_policy_versions SET status='pending' WHERE runner_id='r' AND revision=1");
      else {
        policy.workspaces[0]!.root_path = "/changed-workspace";
        state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=? WHERE runner_id='r' AND revision=1", change === "malformed-snapshot" ? "{}" : JSON.stringify(policy));
      }
      expect(instance.getPolicyReadiness("r")).toMatchObject({ ok: false, code: "stale_policy" });
    });
  },
);

it("policy readiness propagates snapshot storage failure", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`readiness-storage-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    ready(instance, state);
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      if (query.includes("FROM runner_policy_versions")) throw new Error("synthetic policy storage failure");
      return exec(query, ...args);
    });
    try { expect(() => instance.getPolicyReadiness("r")).toThrow("synthetic policy storage failure"); }
    finally { spy.mockRestore(); }
  });
});

it.each([1, 64])("workspace listing uses bounded SQL reads with %i workspaces and no writes", async count => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`permission-cost-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    seed(instance, state, count);
    const cursors: Array<{ readonly rowsRead: number; readonly rowsWritten: number }> = [];
    const queries: string[] = [];
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      queries.push(query);
      const cursor = exec(query, ...args); cursors.push(cursor); return cursor;
    });
    let result: ReturnType<RegistryDO["effectiveWorkspaceList"]>;
    try { result = instance.effectiveWorkspaceList("c", "r"); }
    finally { spy.mockRestore(); }
    const reads = cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
    const writes = cursors.reduce((total, cursor) => total + cursor.rowsWritten, 0);
    const policyReads = queries.filter(query => query.includes("FROM runner_policy_versions")).length;
    console.log(JSON.stringify({ scenario: "workspace_permissions", workspaces: count, queries: queries.length, rows_read: reads, rows_written: writes, policy_reads: policyReads }));
    expect(result?.workspaces).toEqual(Array.from({ length: count }, (_, index) => ({ workspace_id: `w${index}`, enabled: true, permissions: full })));
    expect(writes).toBe(0);
    expect(queries.length).toBe(4);
    expect(reads).toBe(3);
    expect(policyReads).toBe(1);
  });
});

it("workspace listing agrees with single-workspace permissions and filters disabled or unreadable workspaces", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`permission-results-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const policy = seed(instance, state);
    policy.runner_permissions.shell = false;
    policy.workspaces[1]!.enabled = false;
    policy.workspaces[2]!.permissions = { read: false, edit: false, shell: false, job_control: false };
    policy.workspaces[3]!.permissions = readonly;
    const { checksum: _checksum, ...checksumInput } = policy;
    policy.checksum = runnerPolicyChecksum(checksumInput);
    storePolicy(state, policy);
    expect(instance.setClientRunnerOverride("c", "r", { ...full, shell: false, job_control: false }, Date.now())).toBe(true);
    const expected = policy.workspaces.flatMap(workspace => {
      const permissions = instance.effectivePermissions("c", "r", workspace.workspace_id);
      return permissions?.read ? [{ workspace_id: workspace.workspace_id, enabled: true, permissions }] : [];
    });
    expect(expected).toEqual([
      { workspace_id: "w0", enabled: true, permissions: { read: true, edit: true, shell: false, job_control: false } },
      { workspace_id: "w3", enabled: true, permissions: readonly },
    ]);
    expect(instance.effectiveWorkspaceList("c", "r")?.workspaces).toEqual(expected);
    expect(instance.effectivePermissions("c", "r", "missing")).toBeUndefined();
  });
});

it.each(["override", "malformed-override", "scope", "revoke", "validity", "pending-policy", "corrupt-snapshot"] as const)(
  "workspace listing observes a subsequent %s change without cached grants", async change => {
    const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`permission-fresh-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (instance, state) => {
      seed(instance, state);
      expect(instance.effectiveWorkspaceList("c", "r")?.workspaces).toHaveLength(4);
      if (change === "override" || change === "malformed-override") {
        instance.setClientRunnerOverride("c", "r", readonly, Date.now());
        if (change === "malformed-override") state.storage.sql.exec("UPDATE client_runner_overrides SET permissions_json='broken-json' WHERE client_id='c' AND runner_id='r'");
      } else if (change === "scope") instance.updateMcpClientScopes("c", ["coding:read"], Date.now());
      else if (change === "revoke") instance.revokeMcpClient("c", Date.now());
      else if (change === "validity") state.storage.sql.exec("UPDATE runners SET valid_until_ms=? WHERE runner_id='r'", Date.now() - 1);
      else if (change === "pending-policy") state.storage.sql.exec("UPDATE runners SET policy_status='pending' WHERE runner_id='r'");
      else state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json='{}' WHERE runner_id='r' AND revision=1");
      const result = instance.effectiveWorkspaceList("c", "r");
      if (change === "override" || change === "scope") expect(result?.workspaces).toEqual(Array.from({ length: 4 }, (_, index) => ({ workspace_id: `w${index}`, enabled: true, permissions: readonly })));
      else if (change === "malformed-override") expect(result?.workspaces).toEqual([]);
      else expect(result).toBeUndefined();
    });
  },
);

it("workspace listing propagates storage failure instead of returning an empty authorized list", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`permission-storage-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    seed(instance, state);
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      if (query.includes("FROM client_runner_overrides")) throw new Error("synthetic permission storage failure");
      return exec(query, ...args);
    });
    try { expect(() => instance.effectiveWorkspaceList("c", "r")).toThrow("synthetic permission storage failure"); }
    finally { spy.mockRestore(); }
  });
});

it.each([0, 4])("an empty visible workspace list does not read an unused override (%i configured)", async count => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`permission-empty-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const policy = seed(instance, state, count);
    for (const workspace of policy.workspaces) workspace.enabled = false;
    const { checksum: _checksum, ...checksumInput } = policy;
    policy.checksum = runnerPolicyChecksum(checksumInput);
    storePolicy(state, policy);
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    let overrideReads = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      if (query.includes("FROM client_runner_overrides")) { overrideReads++; throw new Error("unused override must not be read"); }
      return exec(query, ...args);
    });
    try {
      expect(instance.effectiveWorkspaceList("c", "r")?.workspaces).toEqual([]);
      expect(overrideReads).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
