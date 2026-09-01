import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeWireFrame, runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { runCli, runEnrollCli, parseProductArgs } from "../src/cli.js";
import { RunnerConnection, classifyConnectionFailure } from "../src/connection.js";
import { RUNNER_VERSION } from "../src/version.js";
import { enrollRunner } from "../src/enrollment.js";
import { ProfileStore, defaultWorkspaceId, validateProfile } from "../src/profile.js";
import { PolicyStore } from "../src/policy-store.js";
import { createServiceManager, createServiceProvisioner, installServiceManifest, isManagedService, removeServiceManifest, renderService, serviceLayout, serviceProfilePath, type ServiceManifestFilesystem } from "../src/service.js";

async function fixture(): Promise<{ root: string; store: ProfileStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "runner-product-"));
  await mkdir(join(root, "workspace"));
  return { root, store: new ProfileStore({ baseDir: join(root, "profile") }), cleanup: () => rm(root, { recursive: true, force: true }) };
}
const profile = (path: string) => ({ version: 1 as const, server_url: "wss://runner.example.test/runner/connect", runner_id: "runner-1", token: "0123456789abcdef", execution_mode: "dedicated_user" as const, workspaces: [{ id: "workspace", path, writable: true, shell: true }] });
const runnerPolicy = (runnerId: string, revision: number) => {
  const unsigned = { schema_version: 1 as const, runner_id: runnerId, revision, runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] as [] };
  return { ...unsigned, checksum: runnerPolicyChecksum(unsigned) };
};

describe("runner product profile and enrollment", () => {
  it("serializes concurrent policy activation and keeps previous policy aligned", async () => {
    const test = await fixture();
    let holdConcurrent = false;
    let firstEntered = false;
    let secondEntered = false;
    let resolveFirstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { resolveFirstEntered = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = new PolicyStore(join(test.root, "state"));
    // Interpose at the start of the private activation body so this test does
    // not depend on platform-specific filesystem latency before the first
    // operation reaches its coordination point.
    type ActivateVerified = (policy: Parameters<PolicyStore["activate"]>[0]) => Promise<void>;
    const internals = store as unknown as { activateVerified: ActivateVerified };
    const originalActivateVerified = internals.activateVerified.bind(store);
    internals.activateVerified = async (policy) => {
      if (holdConcurrent) {
        if (!firstEntered) {
          firstEntered = true;
          resolveFirstEntered();
          await firstGate;
        } else {
          secondEntered = true;
        }
      }
      return originalActivateVerified(policy);
    };
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      const initial = runnerPolicy("policy-queue-runner", 1);
      const next = runnerPolicy("policy-queue-runner", 2);
      const latest = runnerPolicy("policy-queue-runner", 3);
      await store.activate(initial);
      holdConcurrent = true;
      first = store.activate(next);
      // Filesystem setup before the hook is asynchronous (and can be slow on
      // Windows), so synchronize on the hook rather than polling event-loop turns.
      await Promise.race([
        firstEnteredPromise,
        first.then(() => { throw new Error("first activation was not gated"); }, (error) => { throw error; }),
      ]);
      second = store.activate(latest);
      // The second hook must remain behind the first activation. Without the
      // store FIFO it reaches the hook and can rename active-policy.json first.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondEntered).toBe(false);
      releaseFirst();
      await Promise.all([first, second]);
      await expect(store.load("policy-queue-runner")).resolves.toMatchObject({ revision: 3, checksum: latest.checksum });
      await expect(readFile(store.previousPath, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>)).resolves.toMatchObject({ revision: 2, checksum: next.checksum });
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second].filter((promise): promise is Promise<void> => promise !== undefined));
      await test.cleanup();
    }
  });
  it("writes atomic private redacted profile data and suffixes workspace ids", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const raw = await readFile(test.store.filePath, "utf8");
      expect(raw).toContain("0123456789abcdef");
      // Windows ACLs are not represented by the POSIX mode bits exposed by
      // Node's stat(); the service provisioner covers the native ACL path.
      if (process.platform !== "win32") expect((await stat(test.store.filePath)).mode & 0o777).toBe(0o600);
      expect(defaultWorkspaceId("/tmp/workspace", [{ id: "workspace", path: "/tmp/a", writable: true, shell: true }])).toBe("workspace-2");
      const lines: string[] = [];
      await runCli(["status", "--json"], { store: test.store, stdout: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("[redacted]");
      expect(lines.join("\n")).not.toContain("0123456789abcdef");
    } finally { await test.cleanup(); }
  });
  it.skipIf(process.platform === "win32")("rejects a symlinked profile directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-profile-link-"));
    const outside = await mkdtemp(join(tmpdir(), "runner-profile-outside-"));
    try {
      await symlink(outside, join(root, "profile"));
      const store = new ProfileStore({ filePath: join(root, "profile", "profile.json") });
      await expect(store.save(profile(join(root, "workspace")))).rejects.toThrow(/profile directory/);
      await expect(readFile(join(outside, "profile.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")("preserves dedicated-service 0750/0640 profile access across re-enrollment", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      await chmod(join(test.root, "profile"), 0o750);
      await chmod(test.store.filePath, 0o640);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-1" });
      await test.store.save({ ...profile(join(test.root, "workspace")), runner_id: "runner-reenrolled" });
      expect((await stat(join(test.root, "profile"))).mode & 0o777).toBe(0o750);
      expect((await stat(test.store.filePath)).mode & 0o777).toBe(0o640);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-reenrolled" });
    } finally { await test.cleanup(); }
  });
  it("posts one-time code with public information and saves a zero-workspace machine profile without outputting token", async () => {
    const test = await fixture();
    try {
      const calls: RequestInit[] = [];
      const result = await enrollRunner({ server: "https://example.test/runner/enroll", code: "a".repeat(43), cwd: join(test.root, "workspace"), store: test.store, fetch: async (_url, init) => { calls.push(init ?? {}); return new Response(JSON.stringify({ runner_id: "runner-1", server_url: "https://example.test/runner/connect", token: "fedcba9876543210" }), { status: 200 }); } });
      expect(calls).toHaveLength(1); expect(calls[0]?.body).toContain("enrollment_code"); expect(calls[0]?.redirect).toBe("error");
      expect(result.profile).toMatchObject({ server_url: "wss://example.test/runner/connect", workspaces: [] });
    } finally { await test.cleanup(); }
  });
  it("binds the returned connection to the enrollment origin and path", async () => {
    for (const serverUrl of ["https://evil.example/runner/connect", "https://example.test/admin/connect"]) {
      const test = await fixture();
      try {
        await expect(enrollRunner({
          server: "https://example.test/runner/enroll", code: "a".repeat(43), store: test.store,
          fetch: async () => new Response(JSON.stringify({ runner_id: "runner-bound", server_url: serverUrl, token: "bound-token-0123456789" }), { status: 200 }),
        })).rejects.toThrow("outcome is unknown");
        await expect(test.store.load()).resolves.toBeUndefined();
      } finally { await test.cleanup(); }
    }
    const test = await fixture();
    try {
      const requests: string[] = [];
      await enrollRunner({
        server: "https://example.test/runner/enroll/", code: "a".repeat(43), store: test.store,
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ runner_id: "runner-bound", server_url: "https://example.test/runner/connect", token: "bound-token-0123456789" }), { status: 200 });
        },
      });
      expect(requests).toEqual(["https://example.test/runner/enroll"]);
    } finally { await test.cleanup(); }
  });
  it("rejects enrollment responses over the UTF-8 byte cap", async () => {
    const test = await fixture();
    try {
      // 16,384 four-byte code points stay below the character cap but exceed
      // 64 KiB once encoded as UTF-8 (including the JSON envelope).
      const body = JSON.stringify({ runner_id: "runner-large", server_url: "https://example.test/runner/connect", token: "large-token-0123456789", padding: "\u{1F600}".repeat(16_384) });
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024);
      await expect(enrollRunner({
        server: "https://example.test/runner/enroll", code: "a".repeat(43), store: test.store,
        fetch: async () => new Response(body, { status: 200 }),
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
    } finally { await test.cleanup(); }
  });
  it("re-enrollment replaces connection credentials without adding a workspace", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const result = await enrollRunner({ server: "https://example.test/runner/enroll", code: "a".repeat(43), reEnroll: true, cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response(JSON.stringify({ runner_id: "runner-replaced", server_url: "https://example.test/runner/connect", token: "abcdef0123456789" }), { status: 200 }) });
      expect(result.profile).toMatchObject({ runner_id: "runner-replaced", token: "abcdef0123456789", workspaces: original.workspaces });
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-replaced", workspaces: original.workspaces });
    } finally { await test.cleanup(); }
  });
  it("runs the real enrollment CLI with an isolated profile without outputting the token", async () => {
    const test = await fixture();
    try {
      const lines: string[] = []; const errors: string[] = [];
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "a".repeat(43), "--cwd", join(test.root, "workspace"), "--json"], {
        store: test.store, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line),
        fetch: async () => new Response(JSON.stringify({ runner_id: "runner-e2e", server_url: "https://example.test/runner/connect", token: "real-cli-token-must-not-print" }), { status: 200 }),
      });
      expect(lines.join("\n")).toContain("runner-e2e");
      expect(lines.join("\n")).toContain("workspace_count");
      expect(lines.join("\n")).not.toContain("real-cli-token-must-not-print");
      expect(errors).toEqual([]);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-e2e", token: "real-cli-token-must-not-print", workspaces: [] });
    } finally { await test.cleanup(); }
  });
  it("accepts enrollment codes from stdin without putting them in argv", async () => {
    const test = await fixture();
    try {
      const lines: string[] = [];
      const code = "b".repeat(43);
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--json"], {
        store: test.store,
        readStdin: async () => `${code}\n`,
        stdout: (line) => lines.push(line),
        fetch: async (_url, init) => {
          expect(init?.body).toContain(code);
          return new Response(JSON.stringify({ runner_id: "runner-stdin", server_url: "https://example.test/runner/connect", token: "stdin-token-0123456789" }), { status: 200 });
        },
      });
      expect(lines.join("\n")).toContain("runner-stdin");
      expect(await test.store.load()).toMatchObject({ runner_id: "runner-stdin" });
      expect(parseProductArgs(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin"]).values).toMatchObject({ codeStdin: true });
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", code, "--code-stdin"], { store: test.store, readStdin: async () => code })).rejects.toThrow("cannot be used together");
    } finally { await test.cleanup(); }
  });
  it("passes injected enrollment execution mode and privileged-host confirmation through the main CLI", async () => {
    const test = await fixture();
    try {
      const lines: string[] = [];
      await runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "b".repeat(43), "--json"], {
        store: test.store,
        stdout: (line) => lines.push(line),
        executionMode: "privileged_host",
        confirmPrivilegedHost: true,
        fetch: async () => new Response(JSON.stringify({ runner_id: "runner-privileged", server_url: "https://example.test/runner/connect", token: "privileged-token-0123456789" }), { status: 200 }),
      });
      expect(lines.join("\n")).toContain("runner-privileged");
      await expect(test.store.load()).resolves.toMatchObject({ execution_mode: "privileged_host", runner_id: "runner-privileged" });
    } finally { await test.cleanup(); }
  });
  it("removes the profile when post-enrollment activation fails after irreversible redemption", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      const errors: string[] = [];
      await test.store.save(original);
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin", "--re-enroll"], {
        store: test.store,
        readStdin: async () => `${"c".repeat(43)}\n`,
        afterEnroll: async () => { throw new Error("post-enrollment activation failed"); },
        stderr: (line) => errors.push(line),
        fetch: async () => new Response(JSON.stringify({ runner_id: "rollback-runner", server_url: "https://example.test/runner/connect", token: "rollback-token-0123456789" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("credentials were consumed");
      expect(errors.join("\n")).toContain("generate a new enrollment code");
    } finally { await test.cleanup(); }
  });

  it("does not remove a profile replaced by a concurrent enrollment during cleanup", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "c".repeat(43), "--re-enroll"], {
        store: test.store,
        afterEnroll: async () => {
          await test.store.save({ ...profile(join(test.root, "workspace")), runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
          throw new Error("post-enrollment activation failed");
        },
        fetch: async () => new Response(JSON.stringify({ runner_id: "first-runner", server_url: "https://example.test/runner/connect", token: "first-token-0123456789" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
    } finally { await test.cleanup(); }
  });

  it("clears a stale profile and reports an unknown outcome when enrollment transport fails", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "d".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => { throw new Error("socket reset"); },
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
      expect(errors.join("\n")).toContain("generate a new enrollment code");
    } finally { await test.cleanup(); }
  });

  it("preserves a profile written by a concurrent enrollment after an unknown response", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "d".repeat(43), "--re-enroll"], {
        store: test.store,
        fetch: async () => {
          await test.store.save({ ...profile(join(test.root, "workspace")), runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
          throw new Error("socket reset");
        },
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
    } finally { await test.cleanup(); }
  });

  it("does not delete a profile created concurrently when enrollment started empty", async () => {
    const test = await fixture();
    try {
      const concurrent = { ...profile(join(test.root, "workspace")), runner_id: "concurrent-empty-runner", token: "concurrent-empty-token-0123456789" };
      const save = test.store.save.bind(test.store);
      const load = test.store.load.bind(test.store);
      let loads = 0;
      // Model a stale read in the cleanup window: both pre-enrollment reads
      // (and the old helper's ownership check) report no profile even though a
      // separate enrollment writes one immediately after the request starts.
      vi.spyOn(test.store, "load").mockImplementation(async () => {
        loads += 1;
        return loads <= 3 ? undefined : load();
      });
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "e".repeat(43)], {
        store: test.store,
        fetch: async () => {
          await save(concurrent);
          throw new Error("socket reset");
        },
      })).rejects.toThrow("outcome is unknown");
      await expect(load()).resolves.toMatchObject({ runner_id: concurrent.runner_id, token: concurrent.token });
    } finally { await test.cleanup(); }
  });

  it("keeps the previous profile for a definitive enrollment rejection", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "e".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("invalid enrollment", { status: 401 }),
      })).rejects.toThrow("enrollment failed (401)");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: original.runner_id, token: original.token });
      expect(errors).toEqual(["enrollment failed (401)"]);
    } finally { await test.cleanup(); }
  });

  it("keeps the profile when another enrollment already owns the Runner fence", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "g".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("Runner credential mutation is already in progress", { status: 409 }),
      })).rejects.toThrow("already in progress");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: original.runner_id, token: original.token });
      expect(errors).toEqual(["enrollment is already in progress for this Runner; wait for it to finish and retry"]);
    } finally { await test.cleanup(); }
  });

  it("treats redirects as an unknown enrollment outcome", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "h".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response(null, { status: 302, headers: { location: "https://example.test/runner/enroll" } }),
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("treats an invalid response status as an unknown enrollment outcome", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      const invalidStatus = { ok: false, status: 0 } as Response;
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "i".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => invalidStatus,
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("clears the previous profile when a success response cannot be trusted", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "f".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("not-json", { status: 200 }),
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("accepts a code from stdin without outputting the code or token", async () => {
    const test = await fixture();
    try {
      const code = "b".repeat(43); const lines: string[] = []; const errors: string[] = [];
      expect(parseProductArgs(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin"]).values).toMatchObject({ codeStdin: true });
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--json"], {
        store: test.store, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line), readStdin: async () => ` ${code}\n`,
        fetch: async () => new Response(JSON.stringify({ runner_id: "stdin-runner", server_url: "https://example.test/runner/connect", token: "stdin-token-must-not-print" }), { status: 200 }),
      });
      expect(lines.join("\\n")).toContain("stdin-runner");
      expect(lines.join("\\n")).not.toContain(code); expect(lines.join("\\n")).not.toContain("stdin-token-must-not-print"); expect(errors).toEqual([]);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "stdin-runner", token: "stdin-token-must-not-print" });
    } finally { await test.cleanup(); }
  });
  it("rejects empty, invalid, and conflicting stdin enrollment input", async () => {
    const test = await fixture();
    try {
      const error = () => undefined;
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin"], { store: test.store, stderr: error, readStdin: async () => "   ", fetch: async () => new Response() })).rejects.toThrow("--code-stdin requires");
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--code", "a".repeat(43)], { store: test.store, stderr: error, readStdin: async () => "b".repeat(43), fetch: async () => new Response() })).rejects.toThrow("cannot be used together");
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin"], { store: test.store, stderr: error, readStdin: async () => "invalid code", fetch: async () => new Response() })).rejects.toThrow("one-time enrollment code");
    } finally { await test.cleanup(); }
  });

  it("removes a newly enrolled profile if the same CLI operation later fails", async () => {
    const test = await fixture();
    try {
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin", "--profile", test.store.filePath], {
        store: test.store, stderr: () => undefined, readStdin: async () => "c".repeat(43), afterEnroll: async () => { throw new Error("post-enrollment activation failed"); },
        fetch: async () => new Response(JSON.stringify({ runner_id: "rollback-runner", server_url: "https://example.test/runner/connect", token: "rollback-token-must-be-removed" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toBeUndefined();
    } finally { await test.cleanup(); }
  });

  it("rejects cleartext enrollment except explicit loopback development", async () => {
    const test = await fixture();
    try {
      await expect(enrollRunner({ server: "http://example.test/runner/enroll", code: "a".repeat(43), cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response() })).rejects.toThrow("https:// is required");
      await expect(enrollRunner({ server: "https://user:password@example.test/runner/enroll", code: "a".repeat(43), store: test.store, fetch: async () => new Response() })).rejects.toThrow("credentials");
      const result = await enrollRunner({ server: "http://127.0.0.1/runner/enroll", code: "a".repeat(43), insecureLocal: true, cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response(JSON.stringify({ runner_id: "runner-1", server_url: "http://127.0.0.1/runner/connect", token: "fedcba9876543210" }), { status: 200 }) });
      expect(result.profile).toMatchObject({ runner_id: "runner-1", server_url: "ws://127.0.0.1/runner/connect", insecure_local: true });
      await expect(test.store.load()).resolves.toMatchObject({ insecure_local: true });
      expect(validateProfile({ ...result.profile, server_url: "wss://user:password@example.test/runner/connect" })).toBeUndefined();
    } finally { await test.cleanup(); }
  });
});
describe("runner product CLI and service safety", () => {
  it("reports its installed package version instead of a hardcoded transport value", () => {
    expect(RUNNER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const connection = new RunnerConnection({ config: { server: "wss://runner.example.test/runner/connect", runnerId: "version-runner", token: "0123456789abcdef", workspaces: [] } });
    expect((connection as unknown as { metadata: { runner_version: string } }).metadata.runner_version).toBe(RUNNER_VERSION);
  });

  it("parses product CLI options and uses profile defaults for start", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      expect(parseProductArgs(["workspace", "add", "--path", ".", "--readonly", "--json"])).toMatchObject({ command: "workspace", json: true, values: { action: "add", path: ".", readonly: true } });
      let started: unknown;
      await runCli(["start"], { store: test.store, startRunner: async (config) => { started = config; } });
      expect(started).toMatchObject({ runnerId: "runner-1", workspaces: [{ workspaceId: "workspace", readonly: false, shell: true }] });
    } finally { await test.cleanup(); }
  });
  it("uses profile workspaces exactly, including a zero-workspace machine Runner", async () => {
    const test = await fixture();
    try {
      await test.store.save({ ...profile(join(test.root, "workspace")), workspaces: [] });
      let started: unknown;
      await runCli(["start"], { store: test.store, startRunner: async (config) => { started = config; } });
      expect(started).toMatchObject({ runnerId: "runner-1", workspaces: [] });
    } finally { await test.cleanup(); }
  });
  it("renders dedicated-user manifests and uses privileged host only by explicit mode", () => {
    const linux = renderService({ platform: "linux", mode: "system" });
    expect(serviceLayout({ platform: "linux", mode: "system" })).toMatchObject({ installRoot: "/opt/runmesh", configRoot: "/etc/runmesh", stateRoot: "/var/lib/runmesh", logRoot: "/var/log/runmesh", manifestPath: "/etc/systemd/system/runmesh-runner.service" });
    expect(linux).toMatchObject({ executionMode: "dedicated_user" });
    expect(serviceLayout({ platform: "linux", mode: "system" }).executablePath).toBe("/opt/runmesh/current/bin/coding-runner");
    expect(serviceLayout({ platform: "darwin", mode: "system" }).executablePath).toBe("/opt/runmesh/current/bin/coding-runner");
    expect(linux.content).toContain("User=runmesh");
    expect(linux.content).toContain("Group=runmesh");
    expect(linux.content).toContain("ExecStart=/opt/runmesh/current/bin/coding-runner start");
    expect(linux.content).toContain("RUNMESH_RUNNER_PROFILE=/etc/runmesh/profile.json");
    expect(linux.content).not.toContain("coding-runner start\n");
    const macos = renderService({ platform: "darwin", mode: "system" });
    expect(macos.content).toContain("<key>UserName</key><string>runmesh</string>");
    expect(macos.content).toContain("io.alone.runmesh.runner");
    const windows = renderService({ platform: "win32", mode: "system" });
    expect(windows.content).toContain("NT AUTHORITY\\LOCAL SERVICE");
    expect(windows.content).not.toContain("<UserId>SYSTEM</UserId>");
    const privileged = renderService({ platform: "win32", mode: "system", executionMode: "privileged_host" });
    expect(privileged.content).toContain("<UserId>SYSTEM</UserId>");
    expect(Buffer.from(windows.content, "utf8").toString("utf8")).toBe(windows.content);
  });
  it("rejects legacy service commands that try to override profile or state paths", () => {
    for (const command of [
      "/opt/runmesh/current/bin/coding-runner start --profile /tmp/attacker-profile",
      "/opt/runmesh/current/bin/coding-runner start --state-dir=/tmp/attacker-state",
    ]) {
      expect(() => renderService({ platform: "linux", mode: "system", command })).toThrow("cannot override --profile or --state-dir");
    }
    const safe = renderService({ platform: "linux", mode: "system", command: "/opt/runmesh/current/bin/coding-runner start --json" });
    expect(safe.content).toContain("--profile /etc/runmesh/profile.json");
    expect(safe.content).toContain("--state-dir /var/lib/runmesh");
  });
  it("normalizes profile and state paths before rendering a service command", () => {
    const profileStore = new ProfileStore({ filePath: "relative-profile.json" });
    const expectedStorePath = process.platform === "win32" ? win32.resolve("relative-profile.json") : resolve("relative-profile.json");
    expect(profileStore.filePath).toBe(expectedStorePath);
    const manifest = renderService({ platform: "win32", mode: "user", profilePath: "relative-profile.json", stateDir: "relative-state" });
    expect(manifest.content).toContain(win32.resolve("relative-profile.json"));
    expect(manifest.content).toContain(win32.resolve("relative-state"));
    expect(manifest.content).not.toContain("--profile relative-profile.json");
    expect(manifest.content).not.toContain("--state-dir relative-state");
  });
  it("escapes systemd specifiers and control characters in generated values", () => {
    const manifest = renderService({
      platform: "linux", mode: "user", executablePath: "/opt/run%mesh/coding runner",
      profilePath: "/tmp/profile%name\nnext", stateDir: "/tmp/state\tname",
    });
    expect(manifest.content).toContain("ExecStart=/opt/run%%mesh/coding\\x20runner start");
    expect(manifest.content).toContain('RUNMESH_RUNNER_PROFILE=/tmp/profile%%name\\x0anext');
    expect(manifest.content).toContain("--state-dir /tmp/state\\x09name");
    expect(manifest.content).not.toContain("profile%name");
  });
  it("includes fail-closed checks for Windows ACL commands", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const provisioner = createServiceProvisioner({
      platform: "win32",
      executor: { execute: async (file, args) => { calls.push({ file, args }); return { exitCode: 0 }; } },
    });
    const layout = serviceLayout({ platform: "win32", mode: "system" });
    await provisioner.provision(renderService({ platform: "win32", mode: "system" }), serviceProfilePath(layout));
    const script = calls.at(-1)?.args.at(-1) ?? "";
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }");
  });
  it("does not treat a Windows Task Scheduler Ready state as running", async () => {
    const managerFor = (state: string) => createServiceManager({
      platform: "win32", mode: "system",
      executor: { execute: async (_file, args) => args.includes("/FO") ? { exitCode: 0, stdout: `Status: ${state}\nRun As User: NT AUTHORITY\\LOCAL SERVICE` } : { exitCode: 0 } },
    });
    const manifest = renderService({ platform: "win32", mode: "system" });
    await expect(managerFor("Ready").status?.(manifest)).resolves.toMatchObject({ installed: true, active: false });
    await expect(managerFor("Running").status?.(manifest)).resolves.toMatchObject({ installed: true, active: true, identity: "NT AUTHORITY\\LOCAL SERVICE" });
  });
  it("re-applies an unchanged desired policy after activation is interrupted before live publish", async () => {
    const workspaces: [] = [];
    const policyBase = {
      schema_version: 1 as const,
      runner_id: "policy-reapply-runner",
      revision: 1,
      runner_permissions: { read: true, edit: true, shell: true, job_control: true },
      workspaces,
    };
    const desired = { ...policyBase, checksum: runnerPolicyChecksum(policyBase) };
    const firstSocket = { readyState: 1, send: vi.fn() };
    const replacementSocket = { readyState: 1, send: vi.fn() };
    const applied: unknown[][] = [];
    let activationCount = 0;
    const runtime = {
      applyPolicy: (value: unknown[]) => { applied.push(value); },
      syncJobs: async () => [],
      syncWorkspaceMetadata: () => [],
    } as unknown as import("../src/runtime.js").RunnerRuntime;
    const policyStore = {
      activate: async () => {
        activationCount += 1;
        // Simulate the transport being superseded after durable activation but
        // before the live runtime policy is published.
        if (activationCount === 1) (connection as unknown as { socket: unknown }).socket = replacementSocket;
      },
      load: async () => undefined,
    } as unknown as import("../src/policy-store.js").PolicyStore;
    const connection = new RunnerConnection({
      config: { server: "wss://runner.example.test/runner/connect", runnerId: policyBase.runner_id, token: "0123456789abcdef", workspaces: [] },
      runtime,
      policyStore,
    });
    const internals = connection as unknown as {
      socket: unknown;
      applyDesiredPolicy: (socket: unknown, policy: typeof desired) => Promise<void>;
    };
    internals.socket = firstSocket;
    await internals.applyDesiredPolicy(firstSocket, desired);
    expect(applied).toHaveLength(0);
    internals.socket = replacementSocket;
    await internals.applyDesiredPolicy(replacementSocket, desired);
    expect(applied).toHaveLength(1);
  });
  it("re-acknowledges an already-active policy after a reconnect", async () => {
    const policyBase = {
      schema_version: 1 as const,
      runner_id: "policy-reconnect-runner",
      revision: 1,
      runner_permissions: { read: true, edit: true, shell: true, job_control: true },
      workspaces: [] as [],
    };
    const desired = { ...policyBase, checksum: runnerPolicyChecksum(policyBase) };
    const socket = { readyState: 1, send: vi.fn() };
    const runtime = {
      syncJobs: async () => [],
      syncWorkspaceMetadata: () => [],
      applyPolicy: vi.fn(),
    } as unknown as import("../src/runtime.js").RunnerRuntime;
    const policyStore = { activate: vi.fn(), load: async () => undefined } as unknown as import("../src/policy-store.js").PolicyStore;
    const connection = new RunnerConnection({
      config: { server: "wss://runner.example.test/runner/connect", runnerId: policyBase.runner_id, token: "0123456789abcdef", workspaces: [] },
      runtime,
      policyStore,
    });
    const internals = connection as unknown as {
      socket: unknown;
      desiredPolicyRevision: number;
      desiredPolicyChecksum: string;
      appliedPolicyRevision: number | null;
      appliedPolicyChecksum: string | null;
      applyDesiredPolicy: (socket: unknown, policy: typeof desired) => Promise<void>;
    };
    internals.socket = socket;
    internals.desiredPolicyRevision = desired.revision;
    internals.desiredPolicyChecksum = desired.checksum;
    internals.appliedPolicyRevision = desired.revision;
    internals.appliedPolicyChecksum = desired.checksum;
    await internals.applyDesiredPolicy(socket, desired);
    expect(policyStore.activate).not.toHaveBeenCalled();
    const frames = socket.send.mock.calls.map(([value]: [string]) => decodeWireFrame(value));
    expect(frames.some((frame) => frame.type === "runner.policy_ack" && frame.status === "applied" && frame.applied_revision === desired.revision && frame.applied_checksum === desired.checksum)).toBe(true);
    expect(frames.some((frame) => frame.type === "runner.sync")).toBe(true);
  });
  it("quotes Windows task arguments with trailing backslashes safely", () => {
    const executablePath = String.raw`C:\Program Files\Runmesh\current\coding-runner.cmd`;
    const profilePath = String.raw`C:\Program Files\Runmesh\config\profile` + "\\";
    const stateDir = String.raw`C:\Program Files\Runmesh\state` + "\\";
    const manifest = renderService({ platform: "win32", mode: "system", executablePath, profilePath, stateDir });
    const argumentsText = (/<Arguments>([^<]*)<\/Arguments>/u.exec(manifest.content)?.[1] ?? "").replaceAll("&quot;", '"');
    // A trailing separator inside a quoted Windows argument must be doubled
    // before the closing quote; otherwise the parser treats that quote as
    // escaped and hands the service an incorrect path.
    expect(argumentsText).toContain(`--profile "${profilePath}${"\\"}"`);
    expect(argumentsText).toContain(`--state-dir "${stateDir}${"\\"}"`);
    expect(argumentsText).not.toContain(`--profile "${profilePath}"`);
  });
  it("requires explicit confirmation for privileged host services without breaking legacy profiles", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async () => ({ exitCode: 0 }) } });
      await test.store.save({ ...profile(join(test.root, "workspace")), execution_mode: "dedicated_user" });
      const serviceProvisioner = { platform: "linux" as const, provision: async () => ({ identity: "runmesh", profileSecured: true }) };
      await expect(runCli(["install", "--execution-mode", "privileged_host"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true })).rejects.toThrow("confirm-privileged-host");
      await runCli(["install", "--execution-mode", "privileged_host", "--confirm-privileged-host"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true });
      expect([...contents.values()][0]).not.toContain("User=runmesh");
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["install"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true })).resolves.toBeUndefined();
    } finally { await test.cleanup(); }
  });
  it("emits stable doctor JSON checks and only fails its exit seam for required failures", async () => {
    const test = await fixture();
    try {
      await test.store.save({ ...profile(join(test.root, "workspace")), execution_mode: "dedicated_user" });
      const doctorPlatform = process.platform === "win32" ? "win32" : "linux";
      const content = renderService({ platform: doctorPlatform, mode: "system", profilePath: test.store.filePath, executionMode: "dedicated_user" }).content;
      const filesystem: ServiceManifestFilesystem = { read: async () => content, write: async () => undefined, remove: async () => undefined };
      const manager = {
        platform: doctorPlatform, mode: "system" as const,
        install: async () => undefined, stop: async () => undefined, restart: async () => undefined, uninstall: async () => undefined,
        status: async () => ({ installed: true, active: true, identity: "runmesh" }),
      };
      const lines: string[] = []; const exitCodes: number[] = [];
      await runCli(["doctor", "--json"], {
        store: test.store, stdout: (line) => lines.push(line), servicePlatform: doctorPlatform, serviceFilesystem: filesystem, serviceManager: manager,
        discoverShellRuntime: async () => ({ kind: "bash", executable: "/bin/bash", buildInvocation: (command) => ({ file: "/bin/bash", args: ["-lc", command] }) }),
        environment: new (await import("../src/runtime.js")).EnvironmentInfoService({ probe: async (command) => command === "python3" || command === "python" || command === "docker" ? undefined : `${command} version` }),
        policyRevision: async () => ({ desired: 3, applied: 3 }), setExitCode: (code) => exitCodes.push(code),
      });
      const result = JSON.parse(lines[0] ?? "{}") as { ok: boolean; checks: Array<{ name: string; status: string }> };
      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["profile_directory_permissions", "profile_file_permissions", "service_manifest", "service_installed", "service_active", "shell_runtime", "execution_mode", "policy_revision", "tool:python", "tool:docker"]));
      expect(result.checks.filter((check) => check.name === "tool:python" || check.name === "tool:docker").map((check) => ({ name: check.name, status: check.status }))).toEqual([{ name: "tool:python", status: "warning" }, { name: "tool:docker", status: "warning" }]);
      expect(exitCodes).toEqual([]);
      const failingExitCodes: number[] = [];
      // Keep the exit-code seam check independent of host process discovery.
      // Without these injected probes the second doctor invocation would
      // start real PowerShell/tool probes on Windows and can exceed Vitest's
      // default five-second test timeout.
      await runCli(["doctor", "--json"], {
        store: new ProfileStore({ baseDir: join(test.root, "missing-profile") }), stdout: () => undefined,
        servicePlatform: doctorPlatform, serviceFilesystem: filesystem, serviceManager: manager,
        discoverShellRuntime: async () => undefined,
        environment: new (await import("../src/runtime.js")).EnvironmentInfoService({ probe: async () => undefined }),
        setExitCode: (code) => failingExitCodes.push(code),
      });
      expect(failingExitCodes).toEqual([1]);
    } finally { await test.cleanup(); }
  });
  it("requires administrator/root for system installation and uses injected Linux auto-start adapter", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const commands: string[] = [];
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async (file, args) => { commands.push([file, ...args].join(" ")); return { exitCode: 0 }; } } });
      const deniedErrors: string[] = [];
      await expect(runCli(["install"], { store: test.store, stderr: (line) => deniedErrors.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, isAdministrator: () => false })).rejects.toThrow("administrator/root");
      await test.store.save(profile(join(test.root, "workspace")));
      const installOutput: string[] = [];
      await runCli(["install", "--json"], { store: test.store, stdout: (line) => installOutput.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner: { platform: "linux", provision: async () => ({ identity: "runmesh", profileSecured: true }) }, isAdministrator: () => true });
      expect(commands).toEqual(["systemctl daemon-reload", "systemctl enable --now runmesh-runner.service", "systemctl is-active --quiet runmesh-runner.service"]);
      expect([...contents.values()][0]).toContain("ExecStart=/opt/runmesh/current/bin/coding-runner start");
      } finally { await test.cleanup(); }
  });
  it("refuses to activate a service when its profile cannot be secured", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async () => ({ exitCode: 0 }) } });
      const provisioner = { platform: "linux" as const, provision: async () => ({ identity: "runmesh", profileSecured: false, detail: "profile is not present yet" }) };
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["install"], { store: test.store, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner: provisioner, isAdministrator: () => true })).rejects.toThrow("profile is not present yet");
      expect(contents.size).toBe(0);
    } finally { await test.cleanup(); }
  });
  it("renders hashed system service manifests and refuses unrelated overwrite/removal", async () => {
    const test = await fixture();
    try {
      // Use target-platform-shaped fixture roots. A Windows host path is not a
      // valid absolute POSIX path when rendering a Linux/macOS manifest.
      const fixtureHome = "/tmp/runmesh-test-home";
      const manifest = renderService({ platform: "linux", mode: "user", home: fixtureHome });
      expect(manifest.content).toContain("ExecStart="); expect(isManagedService(manifest.content)).toBe(true);
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      await installServiceManifest(manifest, filesystem);
      await filesystem.write(manifest.path, "not ours");
      await expect(installServiceManifest(manifest, filesystem)).rejects.toThrow("unmanaged");
      await expect(removeServiceManifest(manifest, filesystem)).rejects.toThrow("unmanaged");
      expect(renderService({ platform: "darwin", home: fixtureHome }).content).toContain("io.alone.runmesh.runner");
      expect(renderService({ platform: "win32", home: test.root }).content).toContain("Task");
    } finally { await test.cleanup(); }
  });
  it("classifies revoked and HTTP authentication failures separately from networks", () => {
    expect(classifyConnectionFailure({ statusCode: 401 })).toBe("authentication");
    expect(classifyConnectionFailure({ closeCode: 4001, reason: "credentials revoked" })).toBe("authentication");
    expect(classifyConnectionFailure({ closeCode: 1002, reason: "unsupported_protocol_version" })).toBe("authentication");
    expect(classifyConnectionFailure({ error: new Error("ECONNREFUSED") })).toBe("network");
  });
});
