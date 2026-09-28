import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JobManager, type JobEvent } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { jobRecord } from "./helpers/job-record.js";
function gate<T>() {
  let release!: (value: T) => void;
  return {
    promise: new Promise<T>(resolve => {
      release = resolve;
    }),
    release: (value: T) => release(value)
  };
}
async function recovered() {
  const root = await mkdtemp(join(tmpdir(), "runmesh-recovery-ports-"));
  const workspace = join(root, "workspace"),
    stateDir = join(root, "state");
  await mkdir(workspace);
  await mkdir(stateDir, {
    mode: 0o700
  });
  const job = jobRecord();
  const jobDir = join(stateDir, "jobs", job.job_id);
  await mkdir(jobDir, {
    recursive: true,
    mode: 0o700
  });
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(job));
  const alive = {
    alive: true,
    fingerprintMatches: true
  };
  const state = {
    inspect: async (): Promise<{
      alive: boolean;
      fingerprintMatches: boolean | null;
    }> => alive,
    terminate: async (): Promise<boolean> => true,
    signals: 0,
    events: [] as JobEvent[]
  };
  const manager = new JobManager({
    policy: new PathPolicy([{
      workspaceId: "workspace-1",
      rootPath: await realpath(workspace),
      readonly: false,
      shell: false
    }]),
    stateDir,
    onEvent: event => state.events.push(event)
  }, {
    processes: {
      ...nativeJobProcesses,
      spawn: () => {
        throw new Error("recovery must not spawn");
      },
      inspectProcess: () => state.inspect(),
      terminateProcess: async () => {
        state.signals += 1;
        return state.terminate();
      }
    }
  });
  await manager.initialize();
  expect(manager.get(job.job_id).status).toBe("unknown");
  return {
    manager,
    job,
    state,
    persisted: async () => JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8")),
    cleanup: async () => {
      await manager.flushPersistence();
      await rm(root, {
        recursive: true,
        force: true
      });
    }
  };
}
it("does not resurrect a recovered terminal record after an identity probe yields", async () => {
  const h = await recovered();
  const probe = gate<{
    alive: boolean;
    fingerprintMatches: boolean | null;
  }>();
  const entered = gate<void>();
  let pending: Promise<unknown> | undefined;
  try {
    let calls = 0;
    h.state.inspect = async () => {
      calls += 1;
      if (calls === 1) return {
        alive: true,
        fingerprintMatches: true
      };
      if (calls === 2) {
        entered.release();
        return probe.promise;
      }
      return {
        alive: false,
        fingerprintMatches: false
      };
    };
    pending = h.manager.cancel(h.job.job_id);
    await entered.promise;
    const newer = await h.manager.getReconciled(h.job.job_id);
    expect(newer.status).toBe("interrupted");
    probe.release({
      alive: false,
      fingerprintMatches: false
    });
    await expect(pending).resolves.toBe(newer);
    expect(h.manager.get(h.job.job_id)).toBe(newer);
    expect(h.state.signals).toBe(0);
    expect(await h.persisted()).toMatchObject({
      status: "interrupted"
    });
  } finally {
    probe.release({
      alive: false,
      fingerprintMatches: false
    });
    await pending;
    await h.cleanup();
  }
});
it.each([true, null])("preserves recovered cancellation evidence or refuses identity verification %s", async fingerprintMatches => {
  const h = await recovered();
  try {
    h.state.inspect = async () => ({
      alive: true,
      fingerprintMatches
    });
    const result = await h.manager.cancel(h.job.job_id);
    if (fingerprintMatches === null) {
      expect(result).toMatchObject({
        status: "unknown",
        cancellation_delivered_at_ms: null
      });
      expect(h.state.signals).toBe(0);
    } else {
      expect(result).toMatchObject({
        status: "cancelling",
        cancellation_delivered_at_ms: expect.any(Number)
      });
      h.state.inspect = async () => ({
        alive: false,
        fingerprintMatches: false
      });
      expect(await h.manager.getReconciled(h.job.job_id)).toMatchObject({
        status: "cancelled",
        cancellation_delivered_at_ms: result.cancellation_delivered_at_ms
      });
      expect(await h.persisted()).toMatchObject({
        status: "cancelled",
        cancellation_delivered_at_ms: result.cancellation_delivered_at_ms
      });
      expect(h.state.signals).toBe(1);
    }
  } finally {
    await h.cleanup();
  }
});
it("deduplicates concurrent recovered cancellation signals", async () => {
  const h = await recovered();
  const termination = gate<boolean>(),
    entered = gate<void>();
  let pending: Promise<unknown> | undefined;
  try {
    h.state.terminate = async () => {
      entered.release();
      return termination.promise;
    };
    const first = h.manager.cancel(h.job.job_id),
      second = h.manager.cancel(h.job.job_id);
    pending = Promise.all([first, second]);
    await entered.promise;
    termination.release(true);
    await expect(pending).resolves.toEqual([expect.objectContaining({
      status: "cancelling",
      cancellation_delivered_at_ms: expect.any(Number)
    }), expect.objectContaining({
      status: "cancelling",
      cancellation_delivered_at_ms: expect.any(Number)
    })]);
    expect(h.state.signals).toBe(1);
    expect(await h.persisted()).toMatchObject({
      cancellation_delivered_at_ms: expect.any(Number)
    });
  } finally {
    termination.release(true);
    await pending;
    await h.cleanup();
  }
});
it("does not overwrite a newer recovered state after a liveness probe", async () => {
  const h = await recovered();
  const probe = gate<{
      alive: boolean;
      fingerprintMatches: boolean | null;
    }>(),
    entered = gate<void>();
  let pending: Promise<unknown> | undefined;
  try {
    let calls = 0;
    h.state.inspect = async () => {
      if (++calls === 1) {
        entered.release();
        return probe.promise;
      }
      return {
        alive: false,
        fingerprintMatches: false
      };
    };
    pending = h.manager.getReconciled(h.job.job_id);
    await entered.promise;
    const newer = await h.manager.getReconciled(h.job.job_id);
    probe.release({
      alive: false,
      fingerprintMatches: false
    });
    await expect(pending).resolves.toBe(newer);
    expect(h.manager.get(h.job.job_id)).toBe(newer);
    expect(newer.status).toBe("interrupted");
    expect(h.state.events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally {
    probe.release({
      alive: false,
      fingerprintMatches: false
    });
    await pending;
    await h.cleanup();
  }
});
