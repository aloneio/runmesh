import { describe, expect, it } from "vitest";
import { deleteRunner } from "../../apps/worker/src/application/delete-runner.js";
import type { RunnerDeletionPorts } from "../../apps/worker/src/contracts/runner-deletion.js";
function fixture(overrides: Partial<RunnerDeletionPorts> = {}) {
  const calls: string[] = [];
  const note = (name: string, id: string, mutation: string) => { expect(id).toBe("runner"); expect(mutation).toBe("delete-1"); calls.push(name); };
  const ports: RunnerDeletionPorts = {
    mutationId: () => { calls.push("id"); return "delete-1"; },
    fence: async (id, mutation) => { note("fence", id, mutation); return { ok: true }; },
    remove: async (id, mutation) => { note("remove", id, mutation); return { ok: true, status: 204 }; },
    observe: async (id, mutation) => { note("observe", id, mutation); return { runner_exists: true, mutation_committed: false }; },
    cancel: async (id, mutation) => { note("cancel", id, mutation); return { ok: true }; },
    finalize: async (id, mutation) => { note("finalize", id, mutation); }, ...overrides,
  };
  return { ports, calls };
}
describe("Runner deletion use case", () => {
  it("rejects wrong confirmation without touching a port", async () => {
    const f = fixture(); expect(await deleteRunner(f.ports, "runner", "other")).toEqual({ state: "rejected", reason: "confirmation", status: 400 }); expect(f.calls).toEqual([]);
  });
  it("keeps fence, durable removal and finalization in order with one mutation id", async () => {
    const f = fixture(); expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "deleted" }); expect(f.calls).toEqual(["id", "fence", "remove", "finalize"]);
  });
  it("does not commit after a refused fence", async () => {
    const f = fixture({ fence: async () => ({ ok: false }) }); expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "unavailable", reason: "fence" }); expect(f.calls).toEqual(["id"]);
  });
  it.each([400, 404, 409])("observes and cancels deterministic refusal %s, without repeating deletion", async status => {
    const f = fixture({ remove: async () => ({ ok: false, status }) });
    expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "rejected", reason: "registry", status }); expect(f.calls).toEqual(["id", "fence", "observe", "cancel"]);
  });
  it("finalizes a confirmed tombstone rather than cancelling committed deletion", async () => {
    const f = fixture({ remove: async () => ({ ok: false, status: 404 }), observe: async () => ({ runner_exists: false, mutation_committed: true }) });
    expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "deleted" }); expect(f.calls).toEqual(["id", "fence", "finalize"]);
  });
  it.each([500, 502, 503])("unknown upstream status %s never releases the fence", async status => {
    const f = fixture({ remove: async () => ({ ok: false, status }) }); expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "unknown", reason: "commit" }); expect(f.calls).toEqual(["id", "fence"]);
  });
  it("lost commit response is unknown and not automatically retried", async () => {
    const f = fixture({ remove: async () => { throw Error("response lost"); } }); expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "unknown", reason: "commit" }); expect(f.calls).toEqual(["id", "fence"]);
  });
  it("failed recovery does not invent rollback", async () => {
    const f = fixture({ remove: async () => ({ ok: false, status: 409 }), observe: async () => { throw Error("unavailable"); } }); expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "unknown", reason: "recovery" }); expect(f.calls).toEqual(["id", "fence"]);
  });
  it.each([false, true])("failed finalization remains unknown, recovered=%s", async recovered => {
    const f = fixture({ remove: async () => ({ ok: !recovered, status: recovered ? 404 : 204 }), observe: async () => ({ runner_exists: false, mutation_committed: true }), finalize: async () => { throw Error("unavailable"); } });
    expect(await deleteRunner(f.ports, "runner", "runner")).toEqual({ state: "unknown", reason: recovered ? "finalize_recovered" : "finalize" }); expect(f.calls).not.toContain("cancel");
  });
});
