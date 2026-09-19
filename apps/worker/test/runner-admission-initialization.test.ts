import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RunnerDO } from "../src/runner-do.js";

it("does not let a delayed cold-start read erase a newly acquired mutation fence", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`admission-load-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const old = { fenced: true, reconciled: false, runnerId: null, activeRevision: null, activeChecksum: null,
      desiredRevision: null, desiredChecksum: null, connectionEpoch: null, credentialVersion: null, lifecycleId: null,
      sessionId: null, mutationId: null, mutationPhase: "restart_reconcile", preMutationActiveRevision: null,
      preMutationActiveChecksum: null, preMutationDesiredRevision: null, preMutationDesiredChecksum: null, lastReconciledAtMs: null };
    const reads: Array<(value: unknown) => void> = [];
    const storage = new Proxy(state.storage, { get(target, key) {
      if (key === "get") return () => new Promise<unknown>(resolve => { reads.push(resolve); });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const port = new Proxy(state, { get(target, key) {
      if (key === "storage") return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RunnerDO(port, env) as unknown as {
      admission(): Promise<{ fenced: boolean; mutationId: string | null; mutationPhase: string }>;
      beginPolicyMutation(id: string, runnerId: string): Promise<string>;
    };
    const first = instance.admission(), delayed = instance.admission();
    expect(reads).toHaveLength(2);
    reads[0]!(old);
    await first;
    expect(await instance.beginPolicyMutation("new-mutation", "new-runner")).toBe("started");
    reads[1]!(old);
    await delayed;
    expect(await instance.admission()).toMatchObject({ fenced: true, mutationId: "new-mutation", mutationPhase: "precommit" });
    expect(await state.storage.get("policy-admission-v1")).toMatchObject({ mutationId: "new-mutation", mutationPhase: "precommit" });
  });
});
