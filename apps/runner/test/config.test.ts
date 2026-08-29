import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/backoff.js";
import { parseRunnerArgs, validateRunnerConfig } from "../src/config.js";
import { validateCentralWorkspacePolicy } from "../src/policy-config.js";
import { defaultRunnerStateDir } from "../src/state-path.js";

describe("runner configuration", () => {
  it("canonicalizes workspace roots and rejects malformed configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "runmesh-runner-"));
    const config = await validateRunnerConfig({
      server: "ws://127.0.0.1:8787",
      insecureLocal: true,
      token: "0123456789abcdef",
      runnerId: "runner-1",
      workspaces: [`workspace-1=${root}`],
    });
    expect(config.workspaces).toEqual([{ workspaceId: "workspace-1", rootPath: await realpath(root), readonly: true, shell: false }]);
    await expect(validateRunnerConfig({ server: "ws://example.test", token: "0123456789abcdef", runnerId: "runner-1" })).rejects.toThrow("wss://");
    await expect(validateRunnerConfig({ server: "ws://127.0.0.1:8787", token: "0123456789abcdef", runnerId: "runner-1" })).rejects.toThrow("insecure-local");
    await expect(validateRunnerConfig({ server: "wss://example.test", token: "short", runnerId: "runner-1" })).rejects.toThrow("token");
  });
  it("rejects overlapping central workspace roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "runmesh-runner-overlap-"));
    const nested = join(root, "nested");
    await mkdir(nested);
    try {
      const result = await validateCentralWorkspacePolicy([
        { workspace_id: "parent", root_path: root, enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } },
        { workspace_id: "child", root_path: nested, enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } },
      ]);
      expect(result.workspaces).toEqual([]);
      expect(result.status).toEqual([
        { workspace_id: "parent", status: "invalid_path" },
        { workspace_id: "child", status: "invalid_path" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses Runmesh state paths for new local records", () => {
    expect(defaultRunnerStateDir("linux", "/home/test")).toBe("/home/test/.local/state/runmesh");
    expect(defaultRunnerStateDir("darwin", "/Users/test")).toBe("/Users/test/Library/Application Support/Runmesh/state");
    expect(defaultRunnerStateDir("win32", "C:\\Users\\test", "C:\\Users\\test\\AppData\\Local")).toBe("C:\\Users\\test\\AppData\\Local\\Runmesh\\state");
  });
  it("uses RUNMESH_RUNNER_TOKEN when --token is omitted", async () => {
    const oldToken = process.env.RUNMESH_RUNNER_TOKEN;
    process.env.RUNMESH_RUNNER_TOKEN = "0123456789abcdef";
    await expect(validateRunnerConfig({ server: "wss://example.test", runnerId: "runner-1" })).resolves.toMatchObject({ token: "0123456789abcdef" });
    process.env.RUNMESH_RUNNER_TOKEN = oldToken;
  });
  it("uses CODING_RUNNER_TOKEN when --token is omitted", async () => {
    const oldToken = process.env.RUNMESH_RUNNER_TOKEN;
    const oldLegacyToken = process.env.CODING_RUNNER_TOKEN;
    delete process.env.RUNMESH_RUNNER_TOKEN;
    process.env.CODING_RUNNER_TOKEN = "0123456789abcdef";
    await expect(validateRunnerConfig({ server: "wss://example.test", runnerId: "runner-1" })).resolves.toMatchObject({ token: "0123456789abcdef" });
    process.env.RUNMESH_RUNNER_TOKEN = oldToken;
    process.env.CODING_RUNNER_TOKEN = oldLegacyToken;
  });
  it("parses explicit persistent state and transport-disconnect test controls", () => {
    expect(parseRunnerArgs(["--state-dir", "/tmp/state", "--disconnect-after-ms", "25", "--disconnect-control-file", "/tmp/disconnect"])).toMatchObject({ stateDir: "/tmp/state", disconnectAfterMs: 25, disconnectControlFile: "/tmp/disconnect" });
    expect(() => parseRunnerArgs(["--disconnect-after-ms", "0"])).toThrow("positive integer");
  });
});

describe("runner reconnect backoff", () => {
  it("caps at 30 seconds and applies bounded jitter", () => {
    expect(reconnectDelayMs(0, 0)).toBe(750);
    expect(reconnectDelayMs(1, 1)).toBe(2_000);
    expect(reconnectDelayMs(99, 1)).toBe(30_000);
  });
});
