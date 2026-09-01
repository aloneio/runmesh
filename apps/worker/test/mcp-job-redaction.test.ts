import { describe, expect, it } from "vitest";
import { safeEditResult, safeInspectResult, safeJobInputResult, safeJobLogResult, safeJobMetadata, safeReadResult, safeShellResult } from "../src/mcp/server.js";

describe("MCP job metadata boundary", () => {
  it("keeps command, cwd, pid, and process identity out of job results", () => {
    const result = safeJobMetadata({
      job_id: "job-1",
      workspace_id: "workspace-1",
      status: "running",
      created_at_ms: 1,
      started_at_ms: 2,
      updated_at_ms: 3,
      completed_at_ms: null,
      exit_code: null,
      signal: null,
      output_truncated: false,
      cancellation_delivered_at_ms: null,
      command: ["sh", "-c", "cat secret"],
      cwd: "/srv/private-workspace",
      pid: 4242,
      process_start_fingerprint: "fingerprint",
      recovery_liveness: { alive: true },
      argv: ["--token", "sensitive"],
    });

    expect(result).toEqual({
      job_id: "job-1",
      workspace_id: "workspace-1",
      status: "running",
      created_at_ms: 1,
      started_at_ms: 2,
      updated_at_ms: 3,
      completed_at_ms: null,
      exit_code: null,
      signal: null,
      output_truncated: false,
      cancellation_delivered_at_ms: null,
    });
    expect(result).not.toHaveProperty("command");
    expect(result).not.toHaveProperty("cwd");
    expect(result).not.toHaveProperty("pid");
    expect(result).not.toHaveProperty("process_start_fingerprint");
    expect(result).not.toHaveProperty("recovery_liveness");
    expect(result).not.toHaveProperty("argv");
  });

  it("does not copy malformed allow-listed values as nested objects", () => {
    const result = safeJobMetadata({
      job_id: { cwd: "/private/root" },
      workspace_id: ["workspace-1"],
      status: { command: "secret" },
      created_at_ms: { root_path: "/private/root" },
      started_at_ms: -1,
      updated_at_ms: Number.POSITIVE_INFINITY,
      completed_at_ms: { token: "hidden" },
      exit_code: { pid: 42 },
      signal: { cwd: "/private/root" },
      recovery_note: { secret: "hidden" },
      output_truncated: "yes",
      cancellation_delivered_at_ms: { root_path: "/private/root" },
    });

    expect(result).toEqual({});
  });

  it("projects input, logs, and foreground shell envelopes independently", () => {
    const logs = safeJobLogResult({
      job_id: "job-1",
      stream: "stdout",
      data: "token=caller-requested-log-content",
      offset: 0,
      next_cursor: "12",
      truncated: true,
      size: 42,
      command: ["secret-command"],
      cwd: "/private/root",
      pid: 17,
      nested_secret: { password: "hidden" },
    });
    expect(logs).toEqual({ job_id: "job-1", stream: "stdout", data: "token=caller-requested-log-content", offset: 0, next_cursor: "12", truncated: true, size: 42 });

    const input = safeJobInputResult({ accepted: 4, eof: true, job: { command: ["hidden"] }, cwd: "/private/root", pid: 17 });
    expect(input).toEqual({ accepted: 4, eof: true });

    const shell = safeShellResult({
      job: { job_id: "job-1", workspace_id: "workspace-1", status: "succeeded", command: ["hidden"], cwd: "/private/root", pid: 17 },
      completed: true,
      stdout: logs,
      stderr: { job_id: "job-1", stream: "stderr", data: "", offset: 0, next_cursor: null, truncated: false, size: 0, root_path: "/private/root" },
      runner_context: { runner_id: "runner-1", state: "online", available: true, updated_at_ms: 1, automatic_selection: false, root_path: "/private/root" },
      command: ["should-not-cross-boundary"],
      cwd: "/private/root",
      pid: 17,
    });
    expect(shell).toMatchObject({ job_id: "job-1", workspace_id: "workspace-1", status: "succeeded", completed: true, stdout: logs });
    expect(shell.stderr).toEqual({ job_id: "job-1", stream: "stderr", data: "", offset: 0, next_cursor: null, truncated: false, size: 0 });
    expect(shell.runner_context).toEqual({ runner_id: "runner-1", state: "online", available: true, updated_at_ms: 1, automatic_selection: false });
    expect(shell).not.toHaveProperty("job");
    expect(shell).not.toHaveProperty("command");
    expect(shell).not.toHaveProperty("cwd");
    expect(shell).not.toHaveProperty("pid");
  });

  it("keeps filesystem projections workspace-relative and maps the Runner git-diff contract", () => {
    expect(safeReadResult({
      workspace_id: "workspace-1",
      path: "src/index.ts",
      data: "ok",
      encoding: "utf-8",
      offset: 0,
      next_cursor: "1",
      root_path: "C:\\private\\workspace",
      absolute_path: "C:\\private\\workspace\\src\\index.ts",
    })).toEqual({ workspace_id: "workspace-1", path: "src/index.ts", data: "ok", encoding: "utf-8", offset: 0, next_cursor: "1" });

    expect(safeInspectResult({
      workspace_id: "workspace-1",
      path: "src/index.ts",
      staged: false,
      diff: "diff --git a/src/index.ts b/src/index.ts\n-old\n+new",
      encoding: "utf-8",
      bytes: 53,
      truncated: false,
      requested_path: "C:\\private\\workspace\\src\\index.ts",
      output: "secret alias should not win",
    }, "git_diff")).toEqual({
      workspace_id: "workspace-1",
      path: "src/index.ts",
      staged: false,
      diff: "diff --git a/src/index.ts b/src/index.ts\n-old\n+new",
      encoding: "utf-8",
      bytes: 53,
      truncated: false,
    });

    expect(safeEditResult({
      workspace_id: "workspace-1",
      changed_paths: [{ path: "src/index.ts", status: "updated", before_hash: "a".repeat(64), after_hash: "b".repeat(64) }],
      warnings: [{ path: "src/index.ts", backup_path: "C:\\Users\\secret\\backup", error: "EACCES: /private/root" }],
      recovery_note: "restore C:\\Users\\secret\\backup",
    })).toEqual({
      workspace_id: "workspace-1",
      changed_paths: [{ path: "src/index.ts", status: "updated", before_hash: "a".repeat(64), after_hash: "b".repeat(64) }],
      warnings: [{ path: "src/index.ts", code: "recovery_required" }],
    });
  });

  it("does not treat an arbitrary signal string as safe job metadata", () => {
    expect(safeJobMetadata({ job_id: "job-1", signal: "C:\\private\\root" })).toEqual({ job_id: "job-1" });
    expect(safeJobMetadata({ job_id: "job-1", signal: "SIGTERM" })).toEqual({ job_id: "job-1", signal: "SIGTERM" });
  });
});
