import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { CentralGovernance } from "../src/platform/capabilities/central-audit.js";
import { CapabilityState } from "../src/platform/capabilities/store.js";
const owner = () => (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.get((env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.idFromName(crypto.randomUUID()));
const principal = { client_id: 'client-a', secret_version: 1 }, command = { profile_id: 'profile-a', tool_id: 'mcp.' + 'a'.repeat(64), version: 'b'.repeat(64) };
it("Central budgets persist across owner reconstruction and recover without timers", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; const grants = new CapabilityState(state.storage);
    const create = () => new CentralGovernance(state.storage, () => grants.initialize(), () => now), service = create();
    for (let n = 0; n < 30; n++) expect(service.admit(principal, command)).toBe(true);
    expect(create().admit(principal, command)).toBe(false);
    expect(service.admit({ ...principal, client_id: 'client-b' }, command)).toBe(true);
    now += 60_001; expect(service.admit(principal, command)).toBe(true);
  });
});
it("Central cooldown isolates profiles, receipts omit payloads, and history faults do not replay", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; const grants = new CapabilityState(state.storage), service = new CentralGovernance(state.storage, () => grants.initialize(), () => now);
    for (let n = 0; n < 3; n++) {
      expect(service.admit(principal, command)).toBe(true);
      expect(service.record(principal, command, { state: 'failed', code: 'upstream_unavailable', operation_state: 'unknown' }).audit_status).toBe('recorded');
    }
    expect(service.admit(principal, command)).toBe(false);
    expect(service.admit(principal, { profile_id: 'profile-b' })).toBe(true);
    now += 30_001; expect(service.admit(principal, command)).toBe(true);
    const payload = { ...command, arguments: { token: 'DO_NOT_STORE' } };
    service.record(principal, payload, { state: 'completed', operation_state: 'completed' });
    expect(JSON.stringify(service.list())).not.toContain('DO_NOT_STORE');
    expect(service.list()[0]).not.toHaveProperty('runner_id');
    service.record(principal, command, { state: 'failed', operation_state: 'unknown', code: 'DO_NOT_STORE' });
    expect(JSON.stringify(service.list())).not.toContain('DO_NOT_STORE');
    expect(service.list().some(row => row.code === 'result_unconfirmed')).toBe(true);
    state.storage.sql.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON central_receipts_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(service.record(principal, command, { state: 'completed', operation_state: 'completed' }).audit_status).toBe('unavailable');
    now += 86_400_001; expect(service.list()).toEqual([]);
  });
});
