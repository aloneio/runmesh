import { describe, expect, it, vi } from "vitest";
import { UpdateCoordinator } from "../src/updates/coordinator.js";
import { MaintenanceHttpError, UpdateFailure } from "../src/updates/contracts.js";
import { waitForRetry } from "../src/updates/wait.js";
import type { CloudUpdateOperation, CloudUpdateObservation, UpdateCoordinatorOptions, UpdateJournal, UpdateJournalRecord } from "../src/updates/contracts.js";

const operation = (): CloudUpdateOperation => ({ operation_id: "upgrade_1", lifecycle_id: "lifecycle_1", target_version: "0.1.6", target_channel: "stable", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: null, state: "queued", error_code: null, created_at_ms: 1, updated_at_ms: 1 });
function fixture() {
  const events: string[] = []; let now = 0; let active: UpdateJournalRecord | undefined; let cloudOperation = operation();
  let version = "0.1.7"; let connectedVersion: string | null = "0.1.7"; let newSession = false; let cloudDrained = true; let cloudUncertain = false;
  const observe = (): CloudUpdateObservation => ({ operation: cloudOperation, cloud_drained: cloudDrained, cloud_uncertain: cloudUncertain, observed_version: connectedVersion, observed_new_session: newSession });
  const options: UpdateCoordinatorOptions = {
    managerId: "manager_1", recoveryIdentity: async () => "e".repeat(64), now: () => now, sleep: async ms => { now += ms; }, drainTimeoutMs: 4_000, activationTimeoutMs: 4_000,
    cloud: {
      poll: async () => observe(),
      claim: async owner => { events.push("claim"); cloudOperation = { ...cloudOperation, manager_id: owner.manager_id, state: "verifying" }; return observe(); },
      proveStopped: async () => { events.push("drain-proof"); cloudDrained = true; cloudUncertain = false; return observe(); },
      report: async (_owner, state, details = {}) => { events.push(`cloud:${state}`); cloudOperation = { ...cloudOperation, state, error_code: details.error_code ?? null }; return observe(); },
    },
    journal: { load: async () => active, save: async value => { active = structuredClone(value); events.push(`local:${value.phase}`); }, complete: async () => { events.push("complete"); active = undefined; } },
    installation: { inspect: async () => ({ version: "0.1.7", directory: "/managed/versions/old" }), assertRecoverable: async () => { events.push("preflight"); }, switch: async (_previous, next) => { events.push("switch"); version = next.version; }, restore: async previous => { events.push("restore"); version = previous.version; } },
    service: {
      snapshot: async () => ({ schema_version: 1, platform: "linux", mode: "system", registered: true, active: true, enabled: true, enablement: "enabled" }),
      stop: async () => { events.push("stop"); connectedVersion = null; },
      start: async () => { events.push("start"); connectedVersion = version; newSession = true; },
      restoreEnabled: async () => { events.push("restore-enabled"); },
    },
    stage: async target => { events.push(`stage:${target.version}`); return { version: target.version, versionDirectory: "/managed/versions/target", manifestSha256: target.manifest_sha256!, artifactSha256: target.artifact_sha256! }; },
    jobs: async () => ({ idle: true, active: 0 }),
  };
  return { options, events, active: () => active, operation: () => cloudOperation,
    setJournal: (journal: UpdateJournalRecord) => { active = journal; cloudOperation = journal.operation; },
    setNewSession: (value: boolean) => { newSession = value; },
    setCloudDrained: (value: boolean) => { cloudDrained = value; },
    setCloudUncertain: (value: boolean) => { cloudUncertain = value; },
    setOperation: (value: CloudUpdateOperation) => { cloudOperation = value; },
  };
}
function recovering(): UpdateJournal {
  return { schema_version: 1, operation: { ...operation(), manager_id: "manager_1", state: "installing" }, manager_id: "manager_1", recovery_identity: "e".repeat(64), previous: { version: "0.1.7", directory: "/managed/versions/old" }, next: { version: "0.1.6", directory: "/managed/versions/new" }, phase: "switching", service: { schema_version: 1, platform: "win32", mode: "system", registered: true, active: true, enabled: true, enablement: "enabled" } };
}

describe("independent update coordinator", () => {
  it.each([401, 403])("retains the activation journal and reports rejected HTTP %s credentials without another cloud request", async status => {
    const test = fixture(); let rejected = 0;
    const cloud = { ...test.options.cloud, poll: async () => {
      if (test.active()?.phase === "checking") { rejected++; throw new MaintenanceHttpError(status); }
      return test.options.cloud.poll();
    } };
    await expect(new UpdateCoordinator({ ...test.options, cloud }).runOnce()).rejects.toThrow(`maintenance_http_${status}`);
    expect(rejected).toBe(1); expect(test.active()?.phase).toBe("checking");
    expect(test.events).not.toContain("restore");
    await new UpdateCoordinator(test.options).runOnce();
    expect(test.operation().state).toBe("rolled_back"); expect(test.events).toContain("restore"); expect(test.active()).toBeUndefined();
  });

  it.each([401, 403])("keeps HTTP %s visible when authenticating a retained recovery journal", async status => {
    const test = fixture(), saved = recovering(); test.setJournal(saved); let calls = 0;
    await expect(new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, poll: async () => { calls++; throw new MaintenanceHttpError(status); } } }).runOnce()).rejects.toThrow(`maintenance_http_${status}`);
    expect(calls).toBe(1); expect(test.active()).toEqual(saved); expect(test.events).not.toContain("stop");
    await new UpdateCoordinator(test.options).runOnce();
    expect(test.operation().state).toBe("rolled_back"); expect(test.active()).toBeUndefined();
  });

  it.each([429, 503])("keeps HTTP %s activation retry timing inside the existing deadline", async status => {
    const test = fixture(), delays: number[] = []; let failed = false, checkingReads = 0;
    const cloud = { ...test.options.cloud, poll: async () => {
      if (test.active()?.phase === "checking") {
        checkingReads++;
        if (!failed) { failed = true; throw new MaintenanceHttpError(status, 120_000); }
      }
      return test.options.cloud.poll();
    } };
    await new UpdateCoordinator({ ...test.options, cloud, sleep: async ms => { delays.push(ms); await test.options.sleep!(ms); } }).runOnce();
    // Once activation expires, one authenticated ownership read admits rollback;
    // a fresh candidate-health request must not bypass the Retry-After window.
    expect(delays).toEqual([4_000]); expect(checkingReads).toBe(2);
    expect(test.operation().state).toBe("rolled_back"); expect(test.events).toContain("restore");
  });

  it("finishes local rollback promptly when stopping during an unknown activation result", async () => {
    const test = fixture(), controller = new AbortController(); let delays = 0;
    const cloud = { ...test.options.cloud, poll: async () => {
      if (test.active()?.phase === "checking") { controller.abort(); throw new DOMException("Stopped", "AbortError"); }
      return test.options.cloud.poll();
    } };
    await expect(new UpdateCoordinator({ ...test.options, cloud, signal: controller.signal, sleep: async ms => { delays++; await test.options.sleep!(ms); } }).runOnce()).rejects.toThrow("rollback_failed");
    expect(delays).toBe(0); expect(test.events).toContain("restore");
    expect(test.active()).toMatchObject({ phase: "recovery_required", error_code: "rollback_failed" });
  });

  it.each([429, 503])("interrupts an HTTP %s activation retry wait when the manager stops", async status => {
    vi.useFakeTimers();
    const test = fixture(), controller = new AbortController();
    const options = { ...test.options, sleep: (ms: number) => waitForRetry(ms, controller.signal) };
    let finished = false, checkingReads = 0;
    const cloud = { ...test.options.cloud, poll: async () => {
      if (test.active()?.phase === "checking" && ++checkingReads === 1) throw new MaintenanceHttpError(status, 120_000);
      return test.options.cloud.poll();
    } };
    const running = new UpdateCoordinator({ ...options, cloud, now: () => Date.now(), activationTimeoutMs: 120_000, signal: controller.signal }).runOnce()
      .then(() => { finished = true; return undefined; }, error => { finished = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(test.active()?.phase).toBe("checking"); expect(checkingReads).toBe(1);
      controller.abort(); await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true);
      expect(await running).toMatchObject({ code: "rollback_failed" });
      expect(test.events).toContain("restore");
      expect(test.active()).toMatchObject({ phase: "recovery_required", error_code: "rollback_failed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(); await vi.runAllTimersAsync(); await running; vi.useRealTimers();
    }
  });

  it("stops polling the drain proof when the manager stops during a conflict retry wait", async () => {
    vi.useFakeTimers();
    const test = fixture(), controller = new AbortController(); test.setCloudUncertain(true); test.setCloudDrained(false);
    const options = { ...test.options, sleep: (ms: number) => waitForRetry(ms, controller.signal) };
    let finished = false, proofReads = 0;
    const cloud = { ...test.options.cloud, proveStopped: async () => { proofReads++; throw new MaintenanceHttpError(409); } };
    const running = new UpdateCoordinator({ ...options, cloud, now: () => Date.now(), activationTimeoutMs: 120_000, signal: controller.signal }).runOnce()
      .then(() => { finished = true; return undefined; }, error => { finished = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(test.active()?.phase).toBe("stopping"); expect(proofReads).toBe(1);
      controller.abort(); await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true); expect(proofReads).toBe(1);
      expect(await running).toMatchObject({ code: "rollback_failed" });
      expect(test.events).toContain("restore"); expect(test.events).not.toContain("switch");
      expect(test.active()).toMatchObject({ phase: "recovery_required", error_code: "rollback_failed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(); await vi.runAllTimersAsync(); await running; vi.useRealTimers();
    }
  });

  it("allows an exact signed downgrade and persists success before releasing the cloud fence", async () => {
    const test = fixture(); await new UpdateCoordinator(test.options).runOnce();
    expect(test.events.indexOf("local:preparing")).toBeLessThan(test.events.indexOf("claim"));
    expect(test.events).toContain("stage:0.1.6");
    expect(test.events.indexOf("local:stopping")).toBeLessThan(test.events.indexOf("stop"));
    expect(test.events.indexOf("stop")).toBeLessThan(test.events.indexOf("switch"));
    expect(test.events.indexOf("local:succeeded")).toBeLessThan(test.events.indexOf("cloud:succeeded"));
    expect(test.operation().state).toBe("succeeded"); expect(test.active()).toBeUndefined();
  });

  it("does not switch when local queued, running or unknown jobs remain", async () => {
    const test = fixture();
    await new UpdateCoordinator({ ...test.options, jobs: async () => ({ idle: false, active: 1 }) }).runOnce();
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("switch");
    expect(test.operation()).toMatchObject({ state: "failed", error_code: "busy_local_jobs" });
  });

  it("does not equate idle local jobs with drained cloud RPCs", async () => {
    const test = fixture(); test.setCloudDrained(false); let scans = 0;
    await new UpdateCoordinator({ ...test.options, jobs: async () => { scans++; return { idle: true, active: 0 }; } }).runOnce();
    expect(scans).toBe(0); expect(test.events).not.toContain("stop");
  });

  it("fails closed on invalid local metadata and never stops the Runner", async () => {
    const test = fixture();
    await new UpdateCoordinator({ ...test.options, jobs: async () => { throw new UpdateFailure("local_state_invalid"); } }).runOnce();
    expect(test.operation().error_code).toBe("local_state_invalid"); expect(test.events).not.toContain("stop");
  });

  it("rechecks metadata replaced during task completion without treating the failed scan as idle", async () => {
    const test = fixture(); let scans = 0;
    await new UpdateCoordinator({ ...test.options, jobs: async () => { if (++scans === 1) throw new UpdateFailure("local_state_invalid"); return { idle: true, active: 0 }; } }).runOnce();
    expect(scans).toBe(3); expect(test.operation().state).toBe("succeeded");
  });

  it.each([null, "0.1.5"])("refuses an unknown or mismatched cloud original version %s", async original_version => {
    const test = fixture(); test.setOperation({ ...test.operation(), original_version });
    await expect(new UpdateCoordinator(test.options).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop"); expect(test.events.some(item => item.startsWith("stage:"))).toBe(false);
    expect(test.operation().state).toBe("failed");
  });

  it("does not claim cloud ownership when local storage cannot persist preparation", async () => {
    const test = fixture();
    const coordinator = new UpdateCoordinator({ ...test.options, journal: { ...test.options.journal, save: async () => { throw new Error("read-only storage"); } } });
    await expect(coordinator.runOnce()).rejects.toThrow("read-only storage");
    expect(test.active()).toBeUndefined(); expect(test.operation()).toMatchObject({ state: "queued", manager_id: null });
    expect(test.events).toEqual([]);
  });

  it.each(["inspect", "snapshot"])("retries pre-journal %s failure after cloud commit but failed fence finalization", async failure => {
    const test = fixture(); let fenced = false; let loseFinalization = true;
    const cloud = { ...test.options.cloud,
      claim: async (owner: Parameters<typeof test.options.cloud.claim>[0]) => { fenced = true; return test.options.cloud.claim(owner); },
      report: async (...args: Parameters<typeof test.options.cloud.report>) => {
        const result = await test.options.cloud.report(...args);
        if (loseFinalization) { loseFinalization = false; throw new MaintenanceHttpError(503); }
        fenced = false; return result;
      },
    };
    const options = { ...test.options, cloud,
      ...(failure === "inspect" ? { installation: { ...test.options.installation, inspect: async () => { throw new Error("invalid pointer"); } } }
        : { service: { ...test.options.service, snapshot: async () => { throw new Error("invalid service"); } } }),
    };
    await expect(new UpdateCoordinator(options).runOnce()).rejects.toThrow("maintenance_http_503");
    expect(test.active()?.phase).toBe("preparing"); expect(fenced).toBe(true);
    expect(test.operation()).toMatchObject({ state: "failed", error_code: "invalid_installation" });
    await new UpdateCoordinator(options).runOnce();
    expect(test.active()).toBeUndefined(); expect(fenced).toBe(false);
    expect(test.events.filter(event => event === "cloud:failed")).toHaveLength(2);
    const completedEvents = [...test.events]; await new UpdateCoordinator(options).runOnce();
    expect(test.events).toEqual(completedEvents);
    expect(test.events).not.toContain("stop"); expect(test.events.some(event => event.startsWith("stage:"))).toBe(false);
  });

  it.each(["before", "after"])("recovers an uncertain full journal write %s replacement without losing its failure receipt", async point => {
    const test = fixture(); let failWrite = true;
    const options = { ...test.options, journal: { ...test.options.journal, save: async (value: UpdateJournalRecord) => {
      if (value.phase === "claimed" && failWrite) {
        failWrite = false;
        if (point === "after") await test.options.journal.save(value);
        throw new Error("journal replacement failed");
      }
      await test.options.journal.save(value);
    } } };
    await expect(new UpdateCoordinator(options).runOnce()).rejects.toThrow("journal replacement failed");
    expect(test.active()?.phase).toBe(point === "before" ? "preparing" : "claimed");
    expect(test.events).not.toContain("cloud:failed");
    await new UpdateCoordinator(options).runOnce();
    expect(test.active()).toBeUndefined(); expect(test.operation().state).toBe("failed");
    expect(test.events).not.toContain("stop"); expect(test.events.some(event => event.startsWith("stage:"))).toBe(false);
  });

  it.each(["before", "after"])("recovers a lost claim response %s ownership commits", async point => {
    const test = fixture(); let loseClaim = true;
    const options = { ...test.options, cloud: { ...test.options.cloud, claim: async (owner: Parameters<typeof test.options.cloud.claim>[0]) => {
      if (loseClaim) {
        loseClaim = false;
        if (point === "after") await test.options.cloud.claim(owner);
        throw new MaintenanceHttpError(503);
      }
      return test.options.cloud.claim(owner);
    } } };
    await expect(new UpdateCoordinator(options).runOnce()).rejects.toThrow("maintenance_http_503");
    expect(test.active()?.phase).toBe("preparing");
    await new UpdateCoordinator(options).runOnce();
    expect(test.active()).toBeUndefined();
    if (point === "after") {
      expect(test.operation()).toMatchObject({ state: "failed", error_code: "invalid_installation" });
      expect(test.events.some(event => event.startsWith("stage:"))).toBe(false);
    } else {
      expect(test.operation()).toMatchObject({ state: "queued", manager_id: null });
      expect(test.events).not.toContain("cloud:failed");
      await new UpdateCoordinator(options).runOnce(); expect(test.operation().state).toBe("succeeded");
    }
  });

  it("retains preparation through a cloud outage and never releases another manager's claim", async () => {
    const test = fixture();
    await expect(new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, claim: async () => {
      test.setOperation({ ...test.operation(), manager_id: "other-manager", state: "verifying" });
      throw new MaintenanceHttpError(409);
    } } }).runOnce()).rejects.toThrow("maintenance_http_409");
    const saved = test.active(); expect(saved?.phase).toBe("preparing");
    await expect(new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, poll: async () => { throw new TypeError("offline"); } } }).runOnce()).rejects.toThrow("offline");
    expect(test.active()).toEqual(saved);
    await new UpdateCoordinator(test.options).runOnce();
    expect(test.active()).toBeUndefined(); expect(test.operation()).toMatchObject({ manager_id: "other-manager", state: "verifying" });
    expect(test.events.some(event => event.startsWith("cloud:"))).toBe(false); expect(test.events).not.toContain("stop");
  });

  it.each(["removed", "operation", "lifecycle"])("retires an unstarted preparation after authenticated %s replacement without a cloud mutation", async replacement => {
    const test = fixture(); test.setJournal({ schema_version: 1, manager_id: "manager_1", phase: "preparing", operation: operation() });
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, poll: async () => ({
      ...await test.options.cloud.poll(), operation: replacement === "removed" ? null : { ...test.operation(),
        ...(replacement === "operation" ? { operation_id: "new-operation" } : { lifecycle_id: "new-lifecycle" }) },
    }) } }).runOnce();
    expect(test.active()).toBeUndefined(); expect(test.events).toEqual(["complete"]);
  });

  it("retains preparation when an operation replacement races its failure receipt", async () => {
    const test = fixture(); test.setJournal({ schema_version: 1, manager_id: "manager_1", phase: "preparing", operation: operation() });
    test.setOperation({ ...operation(), manager_id: "manager_1", state: "verifying" });
    const options = { ...test.options, cloud: { ...test.options.cloud, report: async () => {
      test.setOperation({ ...operation(), operation_id: "new-operation" }); throw new MaintenanceHttpError(409);
    } } };
    await expect(new UpdateCoordinator(options).runOnce()).rejects.toThrow("maintenance_http_409");
    expect(test.active()?.phase).toBe("preparing");
    await new UpdateCoordinator(options).runOnce();
    expect(test.active()).toBeUndefined(); expect(test.operation()).toMatchObject({ operation_id: "new-operation", state: "queued", manager_id: null });
    expect(test.events).toEqual(["complete"]);
  });

  it("resolves disconnected uncertain RPCs only after two idle scans and confirmed native stop", async () => {
    const test = fixture(); test.setCloudDrained(false); test.setCloudUncertain(true); let scans = 0;
    await new UpdateCoordinator({ ...test.options, jobs: async () => { scans++; return { idle: true, active: 0 }; } }).runOnce();
    expect(scans).toBe(2);
    expect(test.events.indexOf("stop")).toBeLessThan(test.events.indexOf("drain-proof"));
    expect(test.events.indexOf("drain-proof")).toBeLessThan(test.events.indexOf("switch"));
    expect(test.operation().state).toBe("succeeded");
  });

  it("restores the old service when the stopped-process proof is rejected", async () => {
    const test = fixture(); test.setCloudDrained(false); test.setCloudUncertain(true);
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, proveStopped: async () => { throw new Error("proof rejected"); } } }).runOnce();
    expect(test.events).not.toContain("switch"); expect(test.events).toContain("restore");
    expect(test.operation().state).toBe("rolled_back");
  });

  it("checks the independently verified staging receipt against the claimed digests", async () => {
    const test = fixture();
    await new UpdateCoordinator({ ...test.options, stage: async () => ({ version: "0.1.6", versionDirectory: "/untrusted", artifactSha256: "c".repeat(64), manifestSha256: "a".repeat(64) }) }).runOnce();
    expect(test.operation().error_code).toBe("verification_failed"); expect(test.events).not.toContain("stop");
  });

  it("stages and verifies the authenticated claimed target instead of the earlier offer", async () => {
    const test = fixture(); const claim = test.options.cloud.claim;
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, claim: async owner => {
      test.setOperation({ ...test.operation(), target_version: "0.1.5", manifest_sha256: "c".repeat(64), artifact_sha256: "d".repeat(64) });
      return claim(owner);
    } } }).runOnce();
    expect(test.events).toContain("stage:0.1.5"); expect(test.events).not.toContain("stage:0.1.6");
    expect(test.operation().state).toBe("succeeded");
  });

  it("does not abandon an already installing cloud operation when its local journal is missing", async () => {
    const test = fixture();
    await expect(new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, claim: async owner => {
      test.setOperation({ ...test.operation(), manager_id: owner.manager_id, state: "installing" });
      return test.options.cloud.poll();
    } } }).runOnce()).rejects.toThrow("local_state_invalid");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("cloud:failed");
    expect(test.operation().state).toBe("installing");
    expect(test.active()?.phase).toBe("preparing");
    await expect(new UpdateCoordinator(test.options).runOnce()).rejects.toThrow("local_state_invalid");
    expect(test.events).not.toContain("cloud:failed");
  });

  it("requires a new authenticated target session, then restores the old package on failure", async () => {
    const test = fixture(); const originalStart = test.options.service.start; let starts = 0;
    await new UpdateCoordinator({ ...test.options, service: { ...test.options.service, start: async () => { await originalStart(); if (++starts === 1) test.setNewSession(false); } } }).runOnce();
    expect(test.events).toContain("restore"); expect(starts).toBe(2);
    expect(test.operation()).toMatchObject({ state: "rolled_back", error_code: "activation_failed" });
    expect(test.events).not.toContain("cloud:succeeded");
  });

  it("recovers a crash inside the Windows junction gap using the original durable snapshot", async () => {
    const test = fixture(); test.setJournal(recovering());
    await new UpdateCoordinator(test.options).runOnce();
    expect(test.events).toContain("restore"); expect(test.events).not.toContain("switch");
    expect(test.events.some(item => item.startsWith("stage:"))).toBe(false);
    expect(test.operation().state).toBe("rolled_back");
    expect(test.events.indexOf("preflight")).toBeLessThan(test.events.indexOf("stop"));
  });

  it.each(["re-enrolled", "removed", "completed", "new-manager"])("does not stop a service after authenticated recovery ownership is %s", async replacement => {
    const test = fixture(); test.setJournal(recovering());
    const cloud = { ...test.options.cloud, poll: async (): Promise<CloudUpdateObservation> => ({
      ...await test.options.cloud.poll(), operation: replacement === "removed" ? null : {
        ...test.operation(), ...(replacement === "re-enrolled" ? { lifecycle_id: "lifecycle_2" } : replacement === "new-manager" ? { manager_id: "manager_2" } : { state: "succeeded" as const }),
      },
    }) };
    await expect(new UpdateCoordinator({ ...test.options, cloud }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
    expect(test.events.some(item => item.startsWith("cloud:"))).toBe(false);
    expect(test.active()).toMatchObject({ phase: "recovery_required", error_code: "invalid_installation" });
  });

  it("checks installation ownership before stopping even when the old cloud operation is still owned", async () => {
    const test = fixture(); test.setJournal(recovering());
    await expect(new UpdateCoordinator({ ...test.options, installation: { ...test.options.installation, assertRecoverable: async () => { throw new UpdateFailure("invalid_installation"); } } }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
  });

  it("restores the original installation through a temporary outage with unchanged durable credentials", async () => {
    const test = fixture(); test.setJournal(recovering()); let polls = 0;
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, poll: async () => {
      if (++polls === 1) throw new TypeError("network unavailable");
      return test.options.cloud.poll();
    } } }).runOnce();
    expect(test.events).toContain("restore"); expect(test.operation().state).toBe("rolled_back");
  });

  it.each(["replaced", "unbound"])("requires authenticated recovery after credentials are %s", async replacement => {
    const test = fixture(); const saved = recovering();
    if (replacement === "unbound") delete (saved as { recovery_identity?: string }).recovery_identity;
    test.setJournal(saved);
    await expect(new UpdateCoordinator({ ...test.options, recoveryIdentity: async () => replacement === "replaced" ? "f".repeat(64) : "e".repeat(64), cloud: { ...test.options.cloud, poll: async () => { throw new TypeError("network unavailable"); } } }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
    expect(test.active()).toEqual(saved);
  });

  it("retries recovery with rotated credentials once authenticated ownership becomes available", async () => {
    const test = fixture(); const saved = recovering(); test.setJournal(saved); let online = false;
    const coordinator = new UpdateCoordinator({ ...test.options, recoveryIdentity: async () => "f".repeat(64), cloud: { ...test.options.cloud, poll: async () => {
      if (!online) throw new TypeError("network unavailable");
      return test.options.cloud.poll();
    } } });
    await expect(coordinator.runOnce()).rejects.toThrow("invalid_installation");
    expect(test.active()).toEqual(saved); expect(test.events).not.toContain("stop");
    online = true; await coordinator.runOnce();
    expect(test.events).toContain("restore"); expect(test.operation().state).toBe("rolled_back");
  });

  it("accepts rotated credentials after authenticating the same operation and lifecycle", async () => {
    const test = fixture(); test.setJournal(recovering()); let identity: string | undefined;
    await new UpdateCoordinator({ ...test.options, recoveryIdentity: async () => "f".repeat(64), journal: { ...test.options.journal, save: async value => {
      if (value.phase === "rolling_back") identity = value.recovery_identity;
      await test.options.journal.save(value);
    } } }).runOnce();
    expect(identity).toBe("f".repeat(64)); expect(test.operation().state).toBe("rolled_back");
  });

  it("rejects credentials replaced between cloud recovery confirmation and service stop", async () => {
    const test = fixture(); test.setJournal(recovering()); let reads = 0;
    await expect(new UpdateCoordinator({ ...test.options, recoveryIdentity: async () => (++reads === 1 ? "e" : "f").repeat(64) }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop");
  });

  it("replays only terminal acknowledgement after a lost success response", async () => {
    const test = fixture(); const report = test.options.cloud.report; let loseSuccess = true;
    const coordinator = new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, report: async (owner, state, details) => {
      const result = await report(owner, state, details);
      if (state === "succeeded" && loseSuccess) { loseSuccess = false; throw new Error("response lost"); }
      return result;
    } } });
    await expect(coordinator.runOnce()).rejects.toThrow("response lost");
    expect(test.active()?.phase).toBe("succeeded"); const stops = test.events.filter(item => item === "stop").length;
    await coordinator.runOnce();
    expect(test.events.filter(item => item === "stop")).toHaveLength(stops); expect(test.events).not.toContain("restore");
    expect(test.active()).toBeUndefined();
  });

  it("rolls back a candidate that dies before the cloud commits success while its fence is still held", async () => {
    const test = fixture(); const report = test.options.cloud.report;
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, report: async (owner, state, details) => {
      if (state === "succeeded") { test.setNewSession(false); throw new MaintenanceHttpError(409); }
      return report(owner, state, details);
    } } }).runOnce();
    expect(test.events).toContain("restore"); expect(test.operation().state).toBe("rolled_back");
  });

  it("retires a terminal journal superseded after a lost receipt without changing the new operation", async () => {
    const test = fixture(); const saved = { ...recovering(), phase: "succeeded" as const }; test.setJournal(saved);
    test.setOperation({ ...operation(), operation_id: "upgrade_2" });
    await new UpdateCoordinator({ ...test.options, cloud: { ...test.options.cloud, report: async () => { throw new MaintenanceHttpError(409); } } }).runOnce();
    expect(test.active()).toBeUndefined(); expect(test.operation().operation_id).toBe("upgrade_2");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
  });

  it.each(["reported", "same_terminal", "replaced_operation", "nonterminal"] as const)("preserves the replacement journal when the installation lease is lost during terminal acknowledgement: %s", async response => {
    const test = fixture(), saved = { ...recovering(), phase: "succeeded" as const };
    const replacement: UpdateJournal = { ...saved, phase: "claimed", operation: { ...saved.operation, operation_id: "upgrade_2", state: "verifying" } };
    test.setJournal(saved);
    let held = true;
    const replaceOwner = () => { held = false; test.setJournal(replacement); };
    const cloud = { ...test.options.cloud,
      report: async (...args: Parameters<typeof test.options.cloud.report>) => {
        if (args[1] !== "succeeded") return test.options.cloud.report(...args);
        if (response !== "reported") throw new MaintenanceHttpError(409);
        const result = await test.options.cloud.report(...args);
        replaceOwner();
        return result;
      },
      poll: async (): Promise<CloudUpdateObservation> => {
        const result = await test.options.cloud.poll();
        const operation: CloudUpdateOperation = response === "replaced_operation" ? replacement.operation
          : { ...saved.operation, state: response === "nonterminal" ? "checking" : "succeeded" };
        replaceOwner();
        return { ...result, operation };
      },
    };
    const error = await new UpdateCoordinator({ ...test.options, cloud,
      assertInstallationLock: () => { if (!held) throw new Error("lease lost"); },
    }).runOnce().then(() => undefined, cause => cause);
    expect({ error: error instanceof Error ? error.message : undefined, active: test.active(),
      mutations: test.events.filter(event => event === "complete" || event === "stop" || event === "restore" || event.startsWith("local:")),
    }).toEqual({ error: "lease lost", active: replacement, mutations: [] });
  });

  it.each(["inspect", "snapshot", "stage"] as const)("preserves the replacement journal when the installation lease is lost during %s", async boundary => {
    const test = fixture();
    const replacement: UpdateJournal = { ...recovering(), phase: "claimed", operation: { ...recovering().operation, operation_id: "upgrade_2", state: "verifying" } };
    let held = true, replacedAt = 0;
    const replaceOwner = (observed: typeof boundary) => {
      if (observed !== boundary) return;
      held = false; test.setJournal(replacement); replacedAt = test.events.length;
    };
    const error = await new UpdateCoordinator({ ...test.options,
      assertInstallationLock: () => { if (!held) throw new Error("lease lost"); },
      installation: { ...test.options.installation, inspect: async () => {
        const result = await test.options.installation.inspect(); replaceOwner("inspect"); return result;
      } },
      service: { ...test.options.service, snapshot: async () => {
        const result = await test.options.service.snapshot(); replaceOwner("snapshot"); return result;
      } },
      stage: async (...args) => {
        const result = await test.options.stage(...args); replaceOwner("stage"); return result;
      },
    }).runOnce().then(() => undefined, cause => cause);
    expect({ error: error instanceof Error ? error.message : undefined, active: test.active(), mutations: test.events.slice(replacedAt) })
      .toEqual({ error: "lease lost", active: replacement, mutations: [] });
  });

  it("retains the fence after a native failure and retries the owned recovery when it becomes available", async () => {
    const test = fixture(); test.setJournal(recovering());
    await expect(new UpdateCoordinator({ ...test.options, installation: { ...test.options.installation, restore: async () => { throw new Error("disk unavailable"); } } }).runOnce()).rejects.toThrow("rollback_failed");
    expect(test.active()?.phase).toBe("recovery_required"); expect(test.operation()).toMatchObject({ state: "checking", error_code: "rollback_failed" });
    const events = test.events.length;
    await new UpdateCoordinator(test.options).runOnce();
    expect(test.events.slice(events)).toEqual(["preflight", "local:rolling_back", "stop", "restore", "start", "restore-enabled", "local:rolled_back", "cloud:rolled_back", "complete"]);
    // A terminal rollback_failed receipt still blocks the Worker fence and
    // future updates; successful recovery must clear that unresolved marker.
    expect(test.active()).toBeUndefined(); expect(test.operation()).toMatchObject({ state: "rolled_back", error_code: "activation_failed" });
  });

  it("keeps a repeated native recovery failure retryable without releasing the cloud fence", async () => {
    const test = fixture(); test.setJournal({ ...recovering(), phase: "recovery_required", error_code: "rollback_failed" });
    const coordinator = new UpdateCoordinator({ ...test.options, installation: { ...test.options.installation, restore: async () => { throw new Error("disk remains unavailable"); } } });
    await expect(coordinator.runOnce()).rejects.toThrow("rollback_failed");
    await expect(coordinator.runOnce()).rejects.toThrow("rollback_failed");
    expect(test.active()).toMatchObject({ phase: "recovery_required", error_code: "rollback_failed" });
    expect(test.operation()).toMatchObject({ state: "checking", error_code: "rollback_failed" });
    expect(test.events.filter(event => event === "preflight")).toHaveLength(2);
    expect(test.events).not.toContain("cloud:rolled_back"); expect(test.events).not.toContain("complete");
  });

  it.each(["removed", "operation", "lifecycle", "manager", "terminal"])("refuses a recovery-required retry after cloud ownership changes: %s", async replacement => {
    const test = fixture(); test.setJournal({ ...recovering(), phase: "recovery_required", error_code: "rollback_failed" });
    const cloud = { ...test.options.cloud, poll: async (): Promise<CloudUpdateObservation> => ({
      ...await test.options.cloud.poll(), operation: replacement === "removed" ? null : { ...test.operation(),
        ...(replacement === "operation" ? { operation_id: "other-operation" } : replacement === "lifecycle" ? { lifecycle_id: "other-lifecycle" }
          : replacement === "manager" ? { manager_id: "other-manager" } : { state: "succeeded" as const }) },
    }) };
    await expect(new UpdateCoordinator({ ...test.options, cloud }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("preflight"); expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
    expect(test.events.some(event => event.startsWith("cloud:"))).toBe(false);
    expect(test.active()?.phase).toBe("recovery_required");
  });

  it.each(["changed", "unbound", "offline"])("requires both unchanged identity and online cloud authority to retry recovery: %s", async condition => {
    const test = fixture(); const saved = { ...recovering(), phase: "recovery_required" as const, error_code: "rollback_failed" as const };
    if (condition === "unbound") delete (saved as { recovery_identity?: string }).recovery_identity;
    test.setJournal(saved);
    await expect(new UpdateCoordinator({ ...test.options,
      recoveryIdentity: async () => (condition === "changed" ? "f" : "e").repeat(64),
      ...(condition === "offline" ? { cloud: { ...test.options.cloud, poll: async () => { throw new TypeError("offline"); } } } : {}),
    }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).toEqual([]); expect(test.active()).toEqual(saved);
  });

  it("does not retry native recovery against a replaced installation path", async () => {
    const test = fixture(); test.setJournal({ ...recovering(), phase: "recovery_required", error_code: "rollback_failed" });
    await expect(new UpdateCoordinator({ ...test.options, installation: { ...test.options.installation, assertRecoverable: async () => { throw new UpdateFailure("invalid_installation"); } } }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
    expect(test.events.some(event => event.startsWith("cloud:"))).toBe(false); expect(test.active()?.phase).toBe("recovery_required");
  });

  it("rechecks retry ownership after the installation preflight and before native stop", async () => {
    const test = fixture(); test.setJournal({ ...recovering(), phase: "recovery_required", error_code: "rollback_failed" }); let reads = 0;
    await expect(new UpdateCoordinator({ ...test.options, recoveryIdentity: async () => (++reads === 1 ? "e" : "f").repeat(64) }).runOnce()).rejects.toThrow("invalid_installation");
    expect(test.events).toContain("preflight"); expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("restore");
    expect(test.events.some(event => event.startsWith("cloud:"))).toBe(false); expect(test.active()?.phase).toBe("recovery_required");
  });

  it("never switches or restores after losing the OS installation lease", async () => {
    const test = fixture(); let held = true; const originalStop = test.options.service.stop;
    const assertInstallationLock = () => { if (!held) throw new Error("lease lost"); };
    await expect(new UpdateCoordinator({ ...test.options, assertInstallationLock, service: { ...test.options.service, stop: async () => { await originalStop(); held = false; } } }).runOnce()).rejects.toThrow("lease lost");
    expect(test.events).not.toContain("switch"); expect(test.events).not.toContain("restore");
    expect(test.active()?.phase).toBe("stopping");
    // The last write made while holding the lease already records possible
    // native work. A new lease holder can recover it without an unowned write.
    held = true;
    await new UpdateCoordinator({ ...test.options, assertInstallationLock }).runOnce();
    expect(test.events).toContain("restore"); expect(test.operation().state).toBe("rolled_back"); expect(test.active()).toBeUndefined();
  });
});
