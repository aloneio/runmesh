import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/backoff.js";
import { parseRunnerArgs, validateRunnerConfig } from "../src/config.js";

describe("runner configuration", () => {
  it("canonicalizes workspace roots and rejects malformed configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-runner-"));
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
  it("uses CODING_RUNNER_TOKEN when --token is omitted", async () => {
    const oldToken = process.env.CODING_RUNNER_TOKEN;
    process.env.CODING_RUNNER_TOKEN = "0123456789abcdef";
    await expect(validateRunnerConfig({ server: "wss://example.test", runnerId: "runner-1" })).resolves.toMatchObject({ token: "0123456789abcdef" });
    process.env.CODING_RUNNER_TOKEN = oldToken;
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
