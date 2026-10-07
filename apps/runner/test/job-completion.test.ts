import { describe, expect, it } from "vitest";
import { finishJobCompletion, type CompletionPorts } from "../src/jobs/completion.js";
import { removeRetainedJobIfCurrent, type RetainedJobPorts } from "../src/jobs/retention.js";
import type { JobRecord } from "../src/jobs/records.js";
import { jobRecord } from "./helpers/job-record.js";
function completion() {
  const state = {
    current: jobRecord() as JobRecord | undefined,
    pending: undefined as Promise<boolean> | undefined,
    delivered: false,
    reserved: false,
    retired: false,
    pruned: false,
    persisted: [] as JobRecord[],
    completed: [] as JobRecord[]
  };
  const ports: CompletionPorts = {
    current: () => state.current,
    pendingTermination: () => state.pending,
    terminationDelivered: () => state.delivered,
    flushLogs: async () => undefined,
    persist: async record => {
      state.persisted.push(record);
    },
    reserveTerminal: reserved => {
      state.reserved = reserved;
    },
    retireProcess: () => {
      state.retired = true;
    },
    publish: record => {
      state.current = record;
    },
    completed: record => {
      state.completed.push(record);
    },
    prune: async () => {
      state.pruned = true;
    },
    now: () => 100
  };
  return {
    state,
    ports,
    finish: (code: number | null = 0) => finishJobCompletion(ports, code, null, false)
  };
}
describe("completion coordination through scoped ports", () => {
  it.each([100, 50])("orders completion and merged metadata after prior updates when the clock is %i", async now => {
    const h = completion();
    h.state.current = jobRecord({ updated_at_ms: 100 });
    h.ports.now = () => now;
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      if (h.state.persisted.length === 1) h.state.current = jobRecord({ updated_at_ms: 102, output_truncated: true });
    };
    await h.finish();
    expect(h.state.persisted.map(record => record.updated_at_ms)).toEqual([101, 103]);
    expect(h.state.current).toMatchObject({ status: "succeeded", updated_at_ms: 103, completed_at_ms: now, output_truncated: true });
  });

  it("publishes completion only after metadata is durable", async () => {
    const h = completion();
    h.ports.persist = async record => {
      expect(h.state.current?.status).toBe("running");
      expect(h.state.completed).toHaveLength(0);
      expect(h.state.reserved).toBe(true);
      h.state.persisted.push(record);
    };
    await h.finish();
    expect(h.state).toMatchObject({
      current: {
        status: "succeeded"
      },
      retired: true,
      reserved: false,
      pruned: true
    });
    expect(h.state.completed).toEqual(h.state.persisted);
  });
  it("does not resurrect a terminal record while completion logs are flushing", async () => {
    const h = completion();
    const terminal = jobRecord({
      status: "interrupted",
      recovery_note: "newer terminal state"
    });
    h.ports.flushLogs = async () => {
      h.state.current = terminal;
    };
    await h.finish();
    expect(h.state.current).toBe(terminal);
    expect(h.state.persisted).toEqual([]);
    expect(h.state.completed).toEqual([]);
  });
  it("waits for a cancellation registered during log flush before finalizing", async () => {
    const h = completion();
    let resolve!: (value: boolean) => void;
    h.ports.flushLogs = async () => {
      h.state.current = jobRecord({
        status: "cancelling"
      });
      h.state.pending = new Promise(r => {
        resolve = r;
      });
    };
    const finish = h.finish(143);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.persisted).toHaveLength(0);
    resolve(true);
    await finish;
    expect(h.state.persisted).toEqual([expect.objectContaining({
      status: "cancelled",
      cancellation_delivered_at_ms: 100
    })]);
  });
  it("does not overwrite a newer terminal identity published after finish persistence", async () => {
    const h = completion();
    const terminal = jobRecord({
      status: "interrupted",
      recovery_note: "newer recovered state"
    });
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      h.state.current = terminal;
    };
    await h.finish();
    expect(h.state.current).toBe(terminal);
    expect(h.state.retired).toBe(true);
    expect(h.state.completed).toEqual([]);
  });
  it("does not retire a newer active process handle after a stale finish", async () => {
    const h = completion();
    const replacement = jobRecord({
      pid: 101,
      process_start_fingerprint: "2000",
      started_at_ms: 4
    });
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      h.state.current = replacement;
    };
    await h.finish();
    expect(h.state.current).toBe(replacement);
    expect(h.state.retired).toBe(false);
    expect(h.state.completed).toEqual([]);
  });
  it("merges output truncation published while finish persistence is in flight", async () => {
    const h = completion();
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      if (h.state.persisted.length === 1) h.state.current = jobRecord({
        output_truncated: true
      });
    };
    await h.finish();
    expect(h.state.persisted).toEqual([expect.objectContaining({
      status: "succeeded",
      output_truncated: false
    }), expect.objectContaining({
      status: "succeeded",
      output_truncated: true
    })]);
    expect(h.state.current).toBe(h.state.persisted[1]);
    expect(h.state.completed).toEqual([h.state.current]);
  });
  it("does not overwrite a cancellation published while finish persistence is in flight", async () => {
    const h = completion();
    const cancellation = jobRecord({
      status: "cancelling"
    });
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      if (h.state.persisted.length === 1) h.state.current = cancellation;else expect(h.state.reserved).toBe(false);
    };
    await h.finish();
    expect(h.state.current).toBe(cancellation);
    expect(h.state.persisted[1]).toBe(cancellation);
    expect(h.state.retired).toBe(false);
    expect(h.state.completed).toEqual([]);
  });
  it.each([false, true])("merges delivered cancellation with code-zero outcome %s", async success => {
    const h = completion();
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      if (h.state.persisted.length === 1) h.state.current = jobRecord({
        status: "cancelling",
        cancellation_delivered_at_ms: 50
      });
    };
    await h.finish(success ? 0 : 143);
    expect(h.state.current).toMatchObject({
      status: success ? "succeeded" : "cancelled",
      cancellation_delivered_at_ms: 50
    });
    expect(h.state.persisted[1]).toBe(h.state.current);
  });
  it.each(["removed", "terminal", "replacement", "same-process"])("preserves the %s state arriving during merged persistence", async kind => {
    const h = completion();
    const latest = kind === "removed" ? undefined : jobRecord({
      status: kind === "terminal" ? "interrupted" : "running",
      pid: kind === "replacement" ? 999 : 100
    });
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      h.state.current = h.state.persisted.length === 1 ? jobRecord({
        output_truncated: true
      }) : latest;
    };
    await h.finish();
    expect(h.state.current).toBe(latest);
    expect(h.state.retired).toBe(kind !== "replacement");
    expect(h.state.completed).toEqual([]);
  });
  it.each(["removed", "terminal", "replacement", "same-process"])("rechecks %s metadata after awaiting a newer termination decision", async kind => {
    const h = completion();
    const latest = kind === "removed" ? undefined : jobRecord({
      status: kind === "terminal" ? "interrupted" : "cancelling",
      pid: kind === "replacement" ? 999 : 100,
      output_truncated: true,
      cancellation_delivered_at_ms: 75,
      updated_at_ms: 102
    });
    h.ports.persist = async record => {
      h.state.persisted.push(record);
      if (h.state.persisted.length === 1) h.state.current = jobRecord({ status: "cancelling" });
    };
    h.ports.pendingTermination = () => h.state.persisted.length === 1 ? (async () => {
      await Promise.resolve();
      h.state.current = latest;
      return true;
    })() : undefined;
    await h.finish(143);
    if (kind === "same-process") {
      expect(h.state.current).toMatchObject({ status: "cancelled", output_truncated: true, cancellation_delivered_at_ms: 75, updated_at_ms: 103 });
      expect(h.state.persisted[1]).toBe(h.state.current);
      expect(h.state.completed).toEqual([h.state.current]);
    } else {
      expect(h.state.current).toBe(latest);
      expect(h.state.persisted).toHaveLength(1);
      expect(h.state.completed).toEqual([]);
    }
    expect(h.state.retired).toBe(kind !== "replacement");
    expect(h.state.reserved).toBe(false);
  });
  it("releases terminal reservation after a failed durable write", async () => {
    const h = completion();
    h.ports.persist = async () => {
      throw new Error("disk unavailable");
    };
    await expect(h.finish()).rejects.toThrow("disk unavailable");
    expect(h.state).toMatchObject({
      reserved: false,
      retired: false,
      current: {
        status: "running"
      },
      completed: []
    });
  });
});
describe("retention coordination through scoped ports", () => {
  function retention() {
    const job = jobRecord({
      status: "succeeded"
    });
    const state = {
      current: job as JobRecord | undefined,
      removed: false,
      retired: false,
      bytes: 12
    };
    const ports: RetainedJobPorts = {
      current: () => state.current,
      busy: () => false,
      cachedBytes: () => undefined,
      measureBytes: async () => state.bytes,
      removeFiles: async () => {
        state.removed = true;
      },
      retire: bytes => {
        expect(bytes).toBe(12);
        state.retired = true;
        state.current = undefined;
      }
    };
    return {
      job,
      state,
      ports
    };
  }
  it("does not prune a terminal snapshot that becomes active while size accounting awaits", async () => {
    const h = retention();
    h.ports.measureBytes = async () => {
      h.state.current = jobRecord();
      return 12;
    };
    expect(await removeRetainedJobIfCurrent(h.job, h.ports)).toBe(false);
    expect(h.state).toMatchObject({
      current: {
        status: "running"
      },
      removed: false,
      retired: false
    });
    const next = retention();
    expect(await removeRetainedJobIfCurrent(next.job, next.ports)).toBe(true);
    expect(next.state).toMatchObject({
      removed: true,
      retired: true
    });
  });
  it("preserves a replacement published while file removal awaits", async () => {
    const h = retention();
    h.ports.removeFiles = async () => {
      h.state.removed = true;
      h.state.current = jobRecord();
    };
    expect(await removeRetainedJobIfCurrent(h.job, h.ports)).toBe(false);
    expect(h.state).toMatchObject({
      current: {
        status: "running"
      },
      removed: true,
      retired: false
    });
  });
  it("does not inspect or remove a snapshot with pending persistence", async () => {
    const h = retention();
    h.ports.busy = () => true;
    h.ports.measureBytes = async () => {
      throw new Error("must not measure");
    };
    expect(await removeRetainedJobIfCurrent(h.job, h.ports)).toBe(false);
    expect(h.state.removed).toBe(false);
  });
});
