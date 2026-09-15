import { BUILD_PROVENANCE } from "../../apps/worker/src/generated-provenance.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTrustedWindowsTool, trustedWindowsRoot } from "../../apps/runner/src/windows-tools.js";
import { catalogContract, MCP_CATALOG_SUMMARY } from "../../apps/worker/src/mcp/catalog-contract.js";

type ToolResult = {
  readonly content?: { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
};
type JsonRpc = { readonly result?: ToolResult; readonly error?: { readonly code?: number; readonly message?: string } };
type McpClient = { readonly endpoint: string };
type CookieJar = Map<string, string>;
type FormFields = Record<string, string | readonly string[]>;

const workerPort = await freePort();
const workerUrl = `http://127.0.0.1:${workerPort}`;
const runnerId = "e2e-runner";
// Invoke the checked-in workspace CLIs through Node directly. npm/npx are
// platform-specific shell shims on Windows and can leave a detached wrapper
// alive after the actual child exits, making the fixture hang during cleanup.
const projectDirectory = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const wranglerCli = resolve(projectDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
// npm hoists workspace dependencies to the repository root on the hosted CI
// runner, while pnpm keeps them under the owning workspace. Resolve both
// layouts so the fixture exercises the same source CLI locally and in CI.
const tsxCli = resolveWorkspaceCli(
  ["node_modules", "tsx", "dist", "cli.mjs"],
  ["apps", "runner", "node_modules", "tsx", "dist", "cli.mjs"],
);
const packageEntry = process.env.RUNMESH_E2E_RUNNER_ENTRY;
if (packageEntry !== undefined && (!existsSync(packageEntry) || !packageEntry.endsWith("runmesh.cjs"))) throw new Error("Invalid packaged Runner entrypoint");
const runnerInvocation = packageEntry === undefined ? [tsxCli, "apps/runner/src/runmesh-entry.ts"] : [resolve(packageEntry)];
const childSpawnOptions = process.platform === "win32" ? { windowsHide: true } : {};
const trustedTaskkill = process.platform === "win32" ? resolveTrustedWindowsTool("taskkill", trustedWindowsRoot()) : undefined;
const adminToken = "e2e-admin-token-0123456789abcdef";
const adminPassword = "e2e-administrator-password";
const workerEnv = {
  ADMIN_TOKEN: adminToken,
  RUNNER_TOKEN_PEPPER: "e2e-runner-token-pepper-not-for-production",
  INTERNAL_CONTROL_SECRET: "e2e-internal-control-secret-not-for-production",
  RUNMESH_TEST_MODE: "1",
};

function resolveWorkspaceCli(...candidates: string[][]): string {
  const resolved = candidates.map((parts) => resolve(projectDirectory, ...parts)).find((path) => existsSync(path));
  if (resolved === undefined) throw new Error(`workspace CLI is not installed; checked: ${candidates.map((parts) => parts.join("/")).join(", ")}`);
  return resolved;
}

describe.sequential("real local MCP → Worker → Runner RPC", () => {
  let requestId = 10;
  let workspace = "";
  let readonlyWorkspace = "";
  let root = "";
  let workerPersist = "";
  let runnerState = "";
  let enrolledProfile = "";
  let enrollmentCode = "";
  let worker: ChildProcess | undefined;
  let runner: ChildProcess | undefined;
  let runnerOutput: (() => string) | undefined;
  let clientA: McpClient | undefined;
  let clientB: McpClient | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mcp-runner-e2e-"));
    workspace = join(root, "workspace");
    readonlyWorkspace = join(root, "readonly-workspace");
    workerPersist = join(root, "wrangler-state");
    runnerState = join(root, "runner-state");
    await mkdir(workspace, { recursive: true });
    await mkdir(readonlyWorkspace, { recursive: true });
    await writeFile(join(workspace, "note.txt"), "hello from a real local runner\n");
    await writeFile(join(workspace, "utf8.txt"), "Hello你好😀éWorld", "utf8");

    worker = spawn(process.execPath, [wranglerCli, "dev", "--local", "--ip", "127.0.0.1", "--config", "apps/worker/wrangler.jsonc", "--port", String(workerPort), "--persist-to", workerPersist, "--show-interactive-dev-session=false", ...workerVars()], {
      cwd: projectDirectory, env: { ...process.env, ...workerEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true, ...childSpawnOptions,
    });
    const workerLog = collectOutput(worker);
    await waitForWorker(workerLog);
    const createdClients = await setupAdminAndClients();
    enrollmentCode = await createBrowserRunnerEnrollment();
    expect(enrollmentCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    clientA = createdClients.clientA;
    clientB = createdClients.clientB;

    // The offline-history compatibility scenario below explicitly needs an
    // immediate archive. Production now defaults to batched; do not silently
    // assume the first cloud snapshot exists before its scheduled upload.
    const { adminJar: historyAdminJar, csrf: historyCsrf } = await adminCredentials();
    const historyResponse = await submitForm(`/admin/runners/${runnerId}/history-settings`, {
      csrf_token: historyCsrf, mode: "immediate", interval_seconds: "300",
      retention_days: "7", local_retention_days: "0",
    }, historyAdminJar);
    expect(historyResponse.status).toBe(303);

    // Exercise the real source CLI against the Worker enrollment endpoint using
    // its isolated profile, then start from that saved profile (no service manager).
    enrolledProfile = join(root, "enrolled-profile.json");
    const enrollmentCli = spawn(process.execPath, [...runnerInvocation, "enroll", "--server", `${workerUrl}/runner/enroll`, "--code-stdin", "--insecure-local", "--cwd", workspace, "--profile", enrolledProfile, "--json"], {
      cwd: projectDirectory, env: { ...process.env, RUNMESH_RUNNER_PROFILE: enrolledProfile }, stdio: ["pipe", "pipe", "pipe"], detached: true, ...childSpawnOptions,
    });
    enrollmentCli.stdin?.end(`${enrollmentCode}\n`);
    const enrollmentCliLog = collectOutput(enrollmentCli);
    await waitForExit(enrollmentCli, 15_000, enrollmentCliLog);
    expect(enrollmentCli.exitCode, enrollmentCliLog().replaceAll(enrollmentCode, "[synthetic-code-redacted]")).toBe(0);
    expect(enrollmentCliLog()).not.toContain(enrollmentCode);
    const profile = await readFile(enrolledProfile, "utf8");
    expect(profile).toContain(`\"runner_id\": \"${runnerId}\"`);
    expect(profile).not.toContain(enrollmentCode);
    // Central policy is configured by the authenticated Panel. Enrollment and
    // Runner startup intentionally begin with zero workspaces.
    const savedProfile = JSON.parse(profile) as Record<string, unknown>;
    expect(savedProfile.workspaces).toEqual([]);

    runner = spawn(process.execPath, [
      ...runnerInvocation, "start", "--profile", enrolledProfile, "--state-dir", runnerState, "--disconnect-control-file", join(root, "disconnect"),
    ], {
      cwd: projectDirectory, env: { ...process.env, RUNMESH_RUNNER_PROFILE: enrolledProfile }, stdio: ["ignore", "pipe", "pipe"], detached: true, ...childSpawnOptions,
    });
    const runnerLog = collectOutput(runner);
    runnerOutput = runnerLog;
    const { adminJar: policyAdminJar, csrf: policyCsrf } = await adminCredentials();
    const runnerPermissionResponse = await submitForm(`/admin/runners/${runnerId}/permissions`, { csrf_token: policyCsrf, read: "true", edit: "true", shell: "true", job_control: "true" }, policyAdminJar);
    expect(runnerPermissionResponse.status).toBe(303);
    const workspaceResponse = await submitForm(`/admin/runners/${runnerId}/workspace-create`, { csrf_token: policyCsrf, workspace_id: "workspace-1", display_name: "Coding workspace", root_path: workspace, enabled: "true", profile: "coding", read: "true", edit: "true", shell: "true", job_control: "true" }, policyAdminJar);
    expect(workspaceResponse.status).toBe(303);
    const readonlyResponse = await submitForm(`/admin/runners/${runnerId}/workspace-create`, { csrf_token: policyCsrf, workspace_id: "readonly-1", display_name: "Read only workspace", root_path: readonlyWorkspace, enabled: "true", profile: "read_only", read: "true", edit: "false", shell: "false", job_control: "false" }, policyAdminJar);
    expect(readonlyResponse.status).toBe(303);
    await waitFor(async () => {
      const status = await fetch(`${workerUrl}/admin/runners/${runnerId}`, { headers: { cookie: cookieHeader(policyAdminJar) } });
      const html = await status.text();
      return /Policy status<\/span>\s*<strong[^>]*>applied\s*·/.test(html);
    }, 15_000, runnerLog);
    expect((await mcpTool("runner_select", { runner_id: runnerId }, clientA)).isError).not.toBe(true);
    expect((await mcpTool("runner_select", { runner_id: runnerId }, clientB)).isError).not.toBe(true);
  }, 90_000);

  afterAll(async () => {
    await stop(runner); await stop(worker);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }, 30_000);

  it("R01 actual local Worker exposes its compiled source without a deployment tag", async () => {
    const response = await fetch(`${workerUrl}/health`, { cache: "no-store" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    const health = await response.json() as any;
    const compiled: { state: string; commit: string | null; tree: string | null; branch: string | null } = BUILD_PROVENANCE;
    if (compiled.state === "clean") {
      expect(health.deployment).toMatchObject({ state: "identified", source: "git_build", commit: compiled.commit, tree: compiled.tree, branch: compiled.branch });
    } else {
      expect(health.deployment).toMatchObject({ state: compiled.state === "conflict" ? "conflict" : "unavailable", commit: null, branch: null });
    }
    console.log(JSON.stringify({ scenario: "actual_worker_build_provenance", state: health.deployment.state, commit: health.deployment.commit, tree: health.deployment.tree }));
  });

  it("enrolls from the browser-issued one-time code, saves an isolated profile, starts, and performs a real read", async () => {
    expect(enrollmentCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(enrolledProfile, "utf8")).not.toContain(enrollmentCode);
    const result = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 128 });
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({ structuredContent: { data: "hello from a real local runner\n" } });
  });
  it("accepts only a per-client secret URL and hides direct or invalid MCP routes", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const direct = await fetch(`${workerUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect(direct.status).toBe(404);
    const invalid = await fetch(`${workerUrl}/${"x".repeat(43)}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect(invalid.status).toBe(404);
    await expect(mcpMessage("runner_list", {})).resolves.toBeDefined();
  });

  it("requires an explicit selection when multiple runners exist and rejects runner_id on coding tools", async () => {
    const otherRunnerId = "e2e-runner-secondary";
    const enrollment = await fetch(`${workerUrl}/admin/runners`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runner_id: otherRunnerId, token: "e2e-runner-secondary-token-0123456789", execution_mode: "dedicated_user" }),
    });
    expect(enrollment.status).toBe(200);

    const { adminJar, csrf } = await adminCredentials();
    const clientC = await createMcpClient("Client C E2E", ["coding:read"], adminJar, csrf);
    const unselected = await mcpTool("workspace_list", {}, clientC);
    expect(unselected).toMatchObject({ isError: true, structuredContent: { error: { code: "runner_not_selected" } } });

    const rejectedRunnerId = await mcpTool("read", { runner_id: runnerId, workspace_id: "workspace-1", path: "note.txt" }, clientA);
    expect(rejectedRunnerId.isError).toBe(true);
  });

  it("rejects POSIX, Windows drive, and UNC paths at the MCP schema boundary", async () => {
    for (const path of ["/etc/passwd", "C:\\Windows\\System32", "\\\\server\\share\\file.txt"]) {
      const result = await mcpMessage("read", { workspace_id: "workspace-1", path, limit: 1 });
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain("workspace-relative");
    }
  });

  it("advertises exactly the compact catalog and leaves legacy public names absent", async () => {
    const response = await fetch((clientA as McpClient).endpoint, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: "tools/list", params: {} }),
    });
    const listed = await readMcp(response) as { result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown; _meta?: Record<string,unknown> }> } };
    expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual(["context", "edit", "inspect", "job", "read", "runner_current", "runner_list", "runner_select", "shell", "workspace_list"].sort());
    const expected = catalogContract();
    for (const advertised of listed.result!.tools!) {
      const wanted = expected.tools.find(tool => tool.name === advertised.name)!;
      expect(advertised.description).toBe(wanted.description);
      expect(advertised.inputSchema).toEqual(wanted.inputSchema);
      expect(advertised.outputSchema).toEqual(wanted.outputSchema);
      expect(advertised.annotations).toEqual(wanted.annotations);
      expect(advertised._meta?.["io.runmesh/catalog"]).toEqual({schema_version:1,sha256:MCP_CATALOG_SUMMARY.sha256});
    }
    const health = await (await fetch(`${workerUrl}/health`)).json() as {mcp_catalog:unknown};
    expect(health.mcp_catalog).toEqual(MCP_CATALOG_SUMMARY);
    const legacy = await mcpMessage("fs_read", { workspace_id: "workspace-1", path: "note.txt" });
    expect(legacy.error?.code).toBe(-32602);
  });

  it("routes read through the live WebSocket runner without exposing its root", async () => {
    const result = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 128 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ workspace_id: "workspace-1", path: "note.txt", data: "hello from a real local runner\n" });
    expect(JSON.stringify(result)).not.toContain(workspace);
  });

  it("R07 real MCP snapshot cursors preserve content and reject an inter-page file replacement", async () => {
    const path="bound-page.txt",text="中😀\r\nabcé";await writeFile(join(workspace,path),text);
    let page=await mcpTool("read",{workspace_id:"workspace-1",path,limit:3,consistency:"snapshot"});
    expect(page.isError).not.toBe(true);const snapshot=page.structuredContent?.snapshot_id;
    expect(snapshot).toMatch(/^[a-f0-9]{64}$/);
    let output="",iterations=0;
    while(true) {
      expect(page.structuredContent).toMatchObject({page_protocol:2,consistency:"snapshot",snapshot_id:snapshot});
      output+=page.structuredContent?.data;expect(++iterations).toBeLessThan(12);
      if(page.structuredContent?.next_cursor===null)break;
      page=await mcpTool("read",{workspace_id:"workspace-1",path,limit:3,cursor:page.structuredContent?.next_cursor});
      expect(page.isError).not.toBe(true);
    }
    expect(output).toBe(text);
    const cursor=page.structuredContent?.resume_cursor;await writeFile(join(workspace,path),"a different source");
    expect(await mcpTool("read",{workspace_id:"workspace-1",path,cursor})).toMatchObject({isError:true,structuredContent:{error:{code:"file_changed"}}});
  });

  it("R07 real append cursors resume an incomplete character without treating growth as rotation", async () => {
    const marker="bound-log-finish";
    const started=await mcpTool("shell",{workspace_id:"workspace-1",background:true,command:nodeCommand("const fs=require('node:fs');process.stdout.write(Buffer.from([0xe4,0xb8]));const t=setInterval(()=>{if(fs.existsSync('bound-log-finish')){clearInterval(t);process.stdout.write(Buffer.from([0xad]));}},25);")});
    const jobId=started.structuredContent?.job_id as string;expect(typeof jobId).toBe("string");
    try {
      let partial:ToolResult={};
      await waitFor(async()=>{partial=await mcpTool("job",{action:"logs",workspace_id:"workspace-1",job_id:jobId,consistency:"append"});return partial.structuredContent?.page_state==="incomplete";},10000);
      expect(partial.structuredContent).toMatchObject({page_protocol:2,data:"",pending_bytes:2,resume_offset:0});
      const cursor=partial.structuredContent?.resume_cursor,snapshot=partial.structuredContent?.snapshot_id;
      await writeFile(join(workspace,marker),"finish");
      await waitFor(async()=>(await mcpTool("job",{action:"get",workspace_id:"workspace-1",job_id:jobId})).structuredContent?.status==="succeeded",10000);
      const done=await mcpTool("job",{action:"logs",workspace_id:"workspace-1",job_id:jobId,cursor});
      expect(done).toMatchObject({structuredContent:{data:"中",page_protocol:2,page_state:"end",snapshot_id:snapshot}});
    } finally { await writeFile(join(workspace,marker),"finish"); }
  });

  it("paginates live filesystem UTF-8 reads without replacement characters", async () => {
    let cursor: string | undefined;
    let output = "";
    do {
      const page = await mcpTool("read", {
        workspace_id: "workspace-1", path: "utf8.txt", ...(cursor === undefined ? {} : { cursor }), limit: 4,
      });
      expect(page.structuredContent?.page_protocol).toBe(1);
      expect(page.structuredContent?.returned_bytes).toBe(Buffer.byteLength(String(page.structuredContent?.data)));
      expect(page.structuredContent?.snapshot_id).toBeNull();
      output += page.structuredContent?.data as string;
      const next = page.structuredContent?.next_cursor;
      cursor = typeof next === "string" ? next : undefined;
    } while (cursor !== undefined);
    expect(output).toBe("Hello你好😀éWorld");
    expect(output).not.toContain("\ufffd");
  });

  it("lists only workspace identifiers without exposing roots", async () => {
    const listed = await mcpTool("workspace_list", {});
    expect(listed.structuredContent).toMatchObject({ workspaces: expect.arrayContaining([expect.objectContaining({ workspace_id: "workspace-1" })]) });
    expect(JSON.stringify(listed)).not.toContain(workspace);
  });

  it("lets Client B discover and query a Client A job through the offline registry snapshot before reconnecting", async () => {
    const started = await mcpTool("shell", {
      // Keep the detached child alive until the test explicitly releases it
      // after the Runner restart. A fixed sleep can finish before the Runner
      // is stopped on a fast CI host, turning recovery into a timing race.
      workspace_id: "workspace-1", command: nodeCommand("const fs = require('node:fs'); const poll = setInterval(() => { if (fs.existsSync('recovery-finish')) { clearInterval(poll); process.stdout.write('completed-after-cross-client-reconnect\\n'); } }, 50)"), background: true,
    }, clientA);
    const jobId = started.structuredContent?.job_id;
    expect(typeof jobId).toBe("string");

    try {
    await writeFile(join(root, "disconnect"), "close transport\n");
    await waitFor(async () => (await mcpTool("runner_list", {}, clientA)).structuredContent?.runners?.some((runner: { runner_id?: string; state?: string }) => runner.runner_id === runnerId && runner.state === "offline"), 5_000);

    const listed = await mcpTool("job", { action: "list" }, clientB);
    expect(listed).toMatchObject({ structuredContent: { runner_id: runnerId, jobs: expect.any(Array), runner_context: { runner_id: runnerId, state: "offline" } } });
    expect((listed.structuredContent?.jobs as Array<{ job_id?: string }>).some((job) => job.job_id === jobId)).toBe(true);

    const duringGap = await mcpTool("job", { action: "get", job_id: jobId as string }, clientB);
    expect(duringGap).toMatchObject({ structuredContent: { runner_state: "offline", source: "registry_snapshot" } });
    const missingDuringGap = await mcpTool("job", { action: "get", job_id: "job-00000000-0000-0000-0000-000000000000" }, clientB);
    expect(missingDuringGap).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });

    // Restart the Runner process after the deliberate transport-only gap; its
    // detached persistent job and registry snapshot remain available.
    await stop(runner);
    runner = spawn(process.execPath, [
      ...runnerInvocation, "start", "--profile", enrolledProfile, "--state-dir", runnerState, "--disconnect-control-file", join(root, "disconnect"),
    ], {
      cwd: projectDirectory, env: { ...process.env, RUNMESH_RUNNER_PROFILE: enrolledProfile }, stdio: ["ignore", "pipe", "pipe"], detached: true, ...childSpawnOptions,
    });
    runnerOutput = collectOutput(runner);
    await waitFor(async () => (await mcpTool("runner_list", {}, clientA)).structuredContent?.runners?.some((item: { runner_id?: string; state?: string }) => item.runner_id === runnerId && item.state === "online"), 15_000, runnerOutput);
    await writeFile(join(workspace, "recovery-finish"), "finish\\n");
    await waitFor(async () => (await mcpTool("job", { action: "get", job_id: jobId as string }, clientB)).structuredContent?.status === "interrupted", 10_000);
    const completedSnapshot = await mcpTool("job", { action: "get", job_id: jobId as string }, clientB);
    expect(completedSnapshot.structuredContent?.status).toBe("interrupted");

    const logs = await mcpTool("job", { action: "logs", job_id: jobId as string, stream: "stdout", limit: 1024 }, clientB);
    expect(logs.structuredContent?.data).toBe("");
    } finally {
      await writeFile(join(workspace, "recovery-finish"), "finish\n");
    }
  }, 35_000);

  it("keeps background shell jobs alive after the MCP response closes and retrieves them from another stateless request", async () => {
    const started = await mcpTool("shell", {
      workspace_id: "workspace-1", command: nodeCommand("setTimeout(() => process.stdout.write('finished-after-mcp-close\\n'), 300)"), background: true,
    });
    const jobId = started.structuredContent?.job_id;
    expect(typeof jobId).toBe("string");
    await waitFor(async () => (await mcpTool("job", { action: "get", job_id: jobId as string })).structuredContent?.status === "succeeded", 10_000);
    const logs = await mcpTool("job", { action: "logs", job_id: jobId as string, stream: "stdout", limit: 1024 });
    expect(logs.structuredContent?.data).toContain("finished-after-mcp-close");
  });

  it("rejects MCP traversal at schema validation and rejects readonly patches at the actual runner", async () => {
    const traversal = await mcpMessage("read", { workspace_id: "workspace-1", path: "../outside", limit: 1 });
    expect(traversal.result?.isError).toBe(true);
    expect(traversal.result?.content?.[0]?.text).toContain("traversal");

    const readonlyPatch = await mcpTool("edit", {
      workspace_id: "readonly-1", patch: "*** Begin Patch\n*** Add File: forbidden.txt\n+x\n*** End Patch",
    });
    expect(readonlyPatch).toMatchObject({ isError: true, structuredContent: { error: { code: "readonly_workspace" } } });
  });

  it("R07 incomplete file tails terminate across real MCP with an explicit resume offset", async () => {
    await writeFile(join(workspace, "partial-page.txt"), Buffer.from([0x6f, 0x6b, 0xe4, 0xb8]));
    const first = await mcpTool("read", { workspace_id: "workspace-1", path: "partial-page.txt", limit: 1024 });
    expect(first.structuredContent).toMatchObject({ data: "ok", next_cursor: "2", page_protocol: 1 });
    const last = await mcpTool("read", { workspace_id: "workspace-1", path: "partial-page.txt", cursor: "2", limit: 1024 });
    expect(last.isError, JSON.stringify(last)).not.toBe(true);
    expect(last.structuredContent).toMatchObject({ data: "", next_cursor: null, page_state: "incomplete", pending_bytes: 2, resume_offset: 2, truncated: true });
  });

  it("R07 escaped Job output keeps real byte cursors after the MCP context envelope is added", async () => {
    const started = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdout.write(String.fromCharCode(0).repeat(25000))"), background: true });
    const jobId = started.structuredContent?.job_id as string;
    await waitFor(async () => (await mcpTool("job", { action: "get", job_id: jobId })).structuredContent?.status === "succeeded", 10000);
    let cursor: string | undefined, bytes = 0, pages = 0;
    do {
      const result = await mcpTool("job", { action: "logs", workspace_id: "workspace-1", job_id: jobId, stream: "stdout", limit: 65536, ...(cursor === undefined ? {} : { cursor }) });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const page = result.structuredContent!;
      expect(page.page_protocol).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
      expect(page.returned_bytes).toBe(Buffer.byteLength(String(page.data)));
      expect(Number(page.returned_bytes)).toBeLessThanOrEqual(16 * 1024);
      bytes += Number(page.returned_bytes); pages += 1; expect(pages).toBeLessThan(10);
      if (page.next_cursor !== null) expect(Number(page.next_cursor)).toBeGreaterThan(Number(cursor ?? 0));
      cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
    } while (cursor !== undefined);
    expect(bytes).toBe(25000);
  });

  it("paginates multibyte stdout to EOF and returns stderr", async () => {
    const job = await mcpTool("shell", {
      workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('😀é😀'); process.stderr.write('stderr-page\\n')"), background: true,
    });
    const jobId = job.structuredContent?.job_id as string;
    expect(jobId).toEqual(expect.any(String));
    await waitFor(async () => (await mcpTool("job", { action: "get", job_id: jobId })).structuredContent?.status === "succeeded", 10_000);
    let cursor: string | undefined;
    let output = "";
    do {
      const page = await mcpTool("job", { action: "logs", job_id: jobId, stream: "stdout", ...(cursor === undefined ? {} : { cursor }), limit: 4 });
      expect(page.structuredContent?.returned_bytes).toBe(Buffer.byteLength(String(page.structuredContent?.data)));
      expect(page.structuredContent?.page_protocol).toBe(1);
      output += page.structuredContent?.data as string;
      const next = page.structuredContent?.next_cursor;
      cursor = typeof next === "string" ? next : undefined;
    } while (cursor !== undefined);
    expect(output).toBe("😀é😀");
    const stderr = await mcpTool("job", { action: "logs", job_id: jobId, stream: "stderr", limit: 1024 });
    expect(stderr.structuredContent?.data).toBe("stderr-page\n");
  });

  it("paginates large real-runner logs and handles concurrent stateless MCP calls", async () => {
    const job = await mcpTool("shell", {
      workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('x'.repeat(50000))"), background: true,
    });
    const jobId = job.structuredContent?.job_id;
    expect(typeof jobId).toBe("string");
    const jobIdValue = jobId as string;
    await waitFor(async () => (await mcpTool("job", { action: "get", job_id: jobIdValue })).structuredContent?.status === "succeeded", 10_000);
    const first = await mcpTool("job", { action: "logs", job_id: jobIdValue, stream: "stdout", limit: 65_536 });
    expect(first.structuredContent).toMatchObject({ truncated: true, offset: 0 });
    expect((first.structuredContent?.data as string).length).toBeLessThanOrEqual(16 * 1024);
    const next = first.structuredContent?.next_cursor;
    expect(typeof next).toBe("string");
    const second = await mcpTool("job", { action: "logs", job_id: jobIdValue, stream: "stdout", cursor: next, limit: 65_536 });
    expect(second.structuredContent?.offset).toBe(16 * 1024);

    const calls = await Promise.all(Array.from({ length: 8 }, () => mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 128 })));
    expect(calls.every((result) => result.isError !== true && result.structuredContent?.data === "hello from a real local runner\n")).toBe(true);
  });

  it("GA-001 writable MCP add/update/move/delete returns success consistent with disk", async () => {
    const edits = [
      "*** Add File: ga-write.txt\n+old",
      "*** Update File: ga-write.txt\n@@\n-old\n+new",
      "*** Update File: ga-write.txt\n*** Move to: ga-moved.txt\n@@\n-new\n+moved",
      "*** Delete File: ga-moved.txt",
    ];
    for (const [index, text] of edits.entries()) {
      const result = await mcpTool("edit", { workspace_id: "workspace-1", patch: `*** Begin Patch\n${text}\n*** End Patch` });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.changed_paths).toBeInstanceOf(Array);
      if (index === 0) expect(await readFile(join(workspace, "ga-write.txt"), "utf8")).toBe("old\n");
      if (index === 1) expect(await readFile(join(workspace, "ga-write.txt"), "utf8")).toBe("new\n");
      if (index === 2) expect(await readFile(join(workspace, "ga-moved.txt"), "utf8")).toBe("moved\n");
    }
    expect(existsSync(join(workspace, "ga-write.txt"))).toBe(false);
    expect(existsSync(join(workspace, "ga-moved.txt"))).toBe(false);
  });

  it("GA-003 real MCP CJK search returns bounded successful pages with an advancing cursor", async () => {
    const directory = join(workspace, "ga-search"); await mkdir(directory);
    for (let index = 0; index < 10; index++) await writeFile(join(directory, `${index}.txt`), (`needle${"中".repeat(4080)}\n`).repeat(10));
    const first = await mcpTool("inspect", { action: "search", workspace_id: "workspace-1", path: "ga-search", query: "needle" });
    expect(first.isError).not.toBe(true);
    expect((first.structuredContent?.results as unknown[]).length).toBeGreaterThan(0);
    expect(typeof first.structuredContent?.next_cursor).toBe("string");
    const second = await mcpTool("inspect", { action: "search", workspace_id: "workspace-1", path: "ga-search", query: "needle", cursor: first.structuredContent?.next_cursor });
    expect(second.isError).not.toBe(true);
    expect(Number(second.structuredContent?.next_cursor)).toBeGreaterThan(Number(first.structuredContent?.next_cursor));
    expect(Buffer.byteLength(JSON.stringify(first.structuredContent))).toBeLessThan(65536);
    await rm(directory, { recursive: true });
  });

  it("GA-011 escaped patch input inside the text limit is rejected before forwarding or mutation", async () => {
    const result = await mcpTool("edit", { workspace_id: "workspace-1", patch: `*** Begin Patch\n*** Add File: ga-too-large.txt\n+${"\\".repeat(600000)}\n*** End Patch` });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_params" } } });
    expect(existsSync(join(workspace, "ga-too-large.txt"))).toBe(false);
  });

  it("multiple MCP clients queue commands on the same Runner while reads remain available", async () => {
    const {adminJar,csrf}=await adminCredentials();
    const other=await createMcpClient("Queue Client B",["coding:read","coding:write","coding:exec"],adminJar,csrf);
    expect((await mcpTool("runner_select",{runner_id:runnerId},other)).isError).not.toBe(true);
    const first=await mcpTool("shell",{workspace_id:"workspace-1",command:nodeCommand("const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('.queue-e2e-release'))clearInterval(t)},15)"),background:true,request_id:"queue-first"});
    const firstId=first.structuredContent?.job_id as string;expect(typeof firstId).toBe("string");
    let secondId:string|undefined;
    try {
      const start=Date.now();
      const second=await mcpTool("shell",{workspace_id:"workspace-1",command:nodeCommand("process.stdout.write('second-client')"),request_id:"queue-second",wait_ms:8000},other);
      secondId=second.structuredContent?.job_id as string;
      expect(second.isError,JSON.stringify(second)).not.toBe(true);
      expect(second.structuredContent?.status).toBe("queued");expect(Date.now()-start).toBeLessThan(5000);
      const read=await mcpTool("read",{workspace_id:"workspace-1",path:"note.txt"},other);expect(read.isError).not.toBe(true);
      await writeFile(join(workspace,".queue-e2e-release"),"release");
      await waitFor(async()=>["succeeded","failed"].includes(String((await mcpTool("job",{action:"get",workspace_id:"workspace-1",job_id:secondId},other)).structuredContent?.status)),8000);
      const result=await mcpTool("job",{action:"get",workspace_id:"workspace-1",job_id:secondId},other);
      expect(result.structuredContent?.status,JSON.stringify(result)).toBe("succeeded");
      const logs=await mcpTool("job",{action:"logs",workspace_id:"workspace-1",job_id:secondId,stream:"stdout",limit:1024},other);
      expect(logs.structuredContent?.data).toBe("second-client");
      const replay=await mcpTool("shell",{workspace_id:"workspace-1",command:nodeCommand("process.stdout.write('second-client')"),request_id:"queue-second",background:true},other);
      expect(replay.structuredContent?.job_id).toBe(secondId);
    } finally {
      await writeFile(join(workspace,".queue-e2e-release"),"release");
      if(secondId)await mcpTool("job",{action:"cancel",workspace_id:"workspace-1",job_id:secondId},other);
      await mcpTool("job",{action:"cancel",workspace_id:"workspace-1",job_id:firstId});
      await waitFor(async()=>!['running','cancelling','queued'].includes(String((await mcpTool("job",{action:"get",workspace_id:"workspace-1",job_id:firstId})).structuredContent?.status)),8000);
    }
  });

  it.skipIf(process.env.RUNMESH_BROWSER_CHECK !== "1" || process.platform !== "linux")("renders stable single-locale dashboard and navigation in Chromium", async () => {
    const {checkUiWithChromium}=await import("../../scripts/ui-browser-check.mjs");
    const {adminJar}=await adminCredentials();
    await checkUiWithChromium(workerUrl,cookieHeader(adminJar),process.env.RUNMESH_BROWSER_OUTPUT);
  },45000);

  it("GA-007 busy Runner returns a retryable busy error, not invalid parameters", async () => {
    const first = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("setTimeout(()=>{},10000)"), background: true });
    const id = first.structuredContent?.job_id as string;
    expect(typeof id).toBe("string");
    try {
      const second = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('never')"), background: true, queue: false });
      expect(second).toMatchObject({ isError: true, structuredContent: { error: { code: "busy" } } });
    } finally {
      await mcpTool("job", { action: "cancel", job_id: id });
      await waitFor(async () => ["cancelled", "succeeded", "failed"].includes(String((await mcpTool("job", { action: "get", job_id: id })).structuredContent?.status)), 12000);
    }
  });

  it("AUTH-E2E-01 readonly client gets effective permissions and cannot edit, execute or cancel", async () => {
    const read = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt" }, clientB);
    expect(read.isError).not.toBe(true);
    const listing = await mcpTool("workspace_list", {}, clientB);
    const workspaceView = (listing.structuredContent?.workspaces as { workspace_id: string; permissions: Record<string, boolean> }[]).find((w) => w.workspace_id === "workspace-1");
    expect(workspaceView?.permissions).toEqual({ read: true, edit: false, shell: false, job_control: false });
    const rejected = [
      await mcpTool("edit", { workspace_id: "workspace-1", patch: "*** Begin Patch\n*** Add File: denied-by-scope.txt\n+never\n*** End Patch" }, clientB),
      await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('never')") }, clientB),
      await mcpTool("job", { action: "cancel", job_id: "not-an-authorized-job" }, clientB),
    ];
    for (const result of rejected) expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
    expect(existsSync(join(workspace, "denied-by-scope.txt"))).toBe(false);
  });

  it("AUTH-E2E-02 task read-sharing does not grant input or cancellation rights", async () => {
    const started = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d))"), background: true });
    const id = started.structuredContent?.job_id as string;
    expect(typeof id).toBe("string");
    try {
      expect((await mcpTool("job", { action: "get", job_id: id }, clientB)).isError).not.toBe(true);
      const denied = await mcpTool("job", { action: "input", job_id: id, data: "unauthorized-input" }, clientB);
      expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
      expect((await mcpTool("job", { action: "input", job_id: id, data: "authorized-input\n" })).isError).not.toBe(true);
      await waitFor(async () => String((await mcpTool("job", { action: "logs", job_id: id }, clientB)).structuredContent?.data).includes("authorized-input"), 10000);
      const log = await mcpTool("job", { action: "logs", job_id: id }, clientB);
      expect(String(log.structuredContent?.data)).not.toContain("unauthorized-input");
    } finally {
      await mcpTool("job", { action: "cancel", job_id: id });
      await waitFor(async () => ["cancelled", "succeeded", "failed"].includes(String((await mcpTool("job", { action: "get", job_id: id })).structuredContent?.status)), 12000);
    }
  });

  it("R08 real MCP inventories Context and prunes only reviewed superseded records", async () => {
    const files = await import("node:fs/promises");
    let contextId = "";
    for (let revision = 1; revision <= 3; revision++) {
      const created = await mcpTool("context", { action: "checkpoint", workspace_id: "workspace-1", turn_id: "retention-e2e", goal: `Retention version ${revision}`,
        ...(contextId ? { context_id: contextId, expected_revision: revision - 1 } : {}) });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      contextId = (created.structuredContent?.context as { context_id: string }).context_id;
    }
    const directory = join(runnerState, "contexts", "workspace-1", contextId);
    // Only this test's private fixture is aged; immutable content fingerprints
    // do not include these retention timestamps. No production state is used.
    for (const revision of [1, 2]) {
      const path = join(directory, `${revision}.json`), record = JSON.parse(await files.readFile(path, "utf8"));
      record.created_at_ms = record.updated_at_ms = Date.now() - 90 * 86400000;
      await files.writeFile(path, `${JSON.stringify(record)}\n`);
    }
    const latest = await files.readFile(join(directory, "3.json"));
    const usage = await mcpTool("context", { action: "storage", workspace_id: "workspace-1" }, clientB);
    expect(usage.isError, JSON.stringify(usage)).not.toBe(true);
    expect(usage.structuredContent).toMatchObject({ storage_schema: 1, accounting: "logical_revision_bytes" });
    expect(JSON.stringify(usage)).not.toContain(runnerState);
    const input = { action: "prune", workspace_id: "workspace-1", keep_days: 30, keep_revisions: 1 };
    expect((await mcpTool("context", input, clientB)).structuredContent?.error).toMatchObject({ code: "insufficient_scope" });
    const preview = await mcpTool("context", input);
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({ applied: false, candidate_records: 2, deleted_records: 0 });
    expect(await files.readdir(directory)).toHaveLength(3);
    const applied = await mcpTool("context", { ...input, apply: true, expected_plan_hash: preview.structuredContent?.plan_hash });
    expect(applied.isError, JSON.stringify(applied)).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({ applied: true, deleted_records: 2, complete: true });
    expect(await files.readdir(directory)).toEqual(["3.json"]);
    expect(await files.readFile(join(directory, "3.json"))).toEqual(latest);
    expect((await mcpTool("context", { action: "read", workspace_id: "workspace-1", context_id: contextId })).structuredContent?.context).toMatchObject({ revision: 3 });
  });

  it("exercises diagnostics, patch preview and all Context methods through final authorization", async () => {
    const diagnostic = await mcpTool("inspect", {action:"diagnostics",workspace_id:"workspace-1"});
    expect(diagnostic.isError, JSON.stringify(diagnostic)).not.toBe(true);
    const checks = diagnostic.structuredContent?.checks as Array<{name:string;state:string}>;
    expect(checks.find((c) => c.name === "runner_rpc")?.state).toBe("pass");
    expect(diagnostic.structuredContent?.capabilities).toMatchObject({report_state:"reported",contract_match:true,host_catalog_state:"not_observed",worker_catalog:MCP_CATALOG_SUMMARY,runner:{features:{job_queue:1,context_record:2}}});
    const readonlyDiagnostic = await mcpTool("inspect",{action:"diagnostics",workspace_id:"workspace-1"},clientB);
    const capability = readonlyDiagnostic.structuredContent?.capabilities as {actions:Array<{method:string;permission_snapshot:string;runner_support:string}>};
    expect(capability.actions.find(action=>action.method==="context.checkpoint")).toMatchObject({runner_support:"supported",permission_snapshot:"denied"});
    expect(JSON.stringify(readonlyDiagnostic)).not.toContain(workspace);
    const preview = await mcpTool("edit", {workspace_id:"workspace-1",preview:true,patch:"*** Begin Patch\n*** Add File: preview-only.txt\n+preview\n*** End Patch"});
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
    expect(existsSync(join(workspace,"preview-only.txt"))).toBe(false);
    const checkpointInput = {action:"checkpoint",turn_id:"e2e-release-audit",goal:"Validate release context chain",expected_revision:0};
    const created = await mcpTool("context",{workspace_id:"workspace-1",...checkpointInput});
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const contextId = (created.structuredContent?.context as {context_id:string}).context_id;
    expect(contextId).toMatch(/^ctx-/);
    const duplicate = await mcpTool("context",{workspace_id:"workspace-1",...checkpointInput});
    expect(duplicate.structuredContent?.deduplicated).toBe(true);
    const operations = [
      {action:"bootstrap"},
      {action:"read",context_id:contextId},
      {action:"search",query:"release"},
      {action:"rebuild"},
    ];
    for (const operation of operations) {
      const result = await mcpTool("context",{workspace_id:"workspace-1",...operation});
      expect(result.isError, JSON.stringify({operation,result})).not.toBe(true);
    }
    const nonexistent = await mcpTool("context",{workspace_id:"workspace-1",...checkpointInput,context_id:"invented-context"});
    expect(nonexistent.structuredContent?.error).toMatchObject({code:"context_revision_conflict"});
    const rejected = await mcpTool("context",{action:"checkpoint",workspace_id:"workspace-1",turn_id:"not-authorized",goal:"must not write"},clientB);
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent?.error).toMatchObject({code:"insufficient_scope"});
  });

  it("queries a batched Job live without waiting for the next cloud snapshot", async () => {
    const { adminJar, csrf } = await adminCredentials();
    const save = async (mode: string) => submitForm(`/admin/runners/${runnerId}/history-settings`, {
      csrf_token: csrf, mode, interval_seconds: "300", retention_days: "7", local_retention_days: "0",
    }, adminJar);
    expect((await save("batched")).status).toBe(303);
    try {
      const started = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('batched-live-log\\n')"), background: true });
      const jobId = started.structuredContent?.job_id;
      expect(typeof jobId).toBe("string");
      await waitFor(async () => (await mcpTool("job", { action: "get", workspace_id: "workspace-1", job_id: jobId })).structuredContent?.status === "succeeded", 10000);
      const listed = await mcpTool("job", { action: "list", workspace_id: "workspace-1", limit: 10 });
      expect(listed.structuredContent?.source).toBe("runner_live");
      expect((listed.structuredContent?.jobs as Array<{job_id?:string}>).some((job) => job.job_id === jobId)).toBe(true);
      const saved = await mcpTool("job", { action: "list", limit: 100 });
      expect((saved.structuredContent?.jobs as Array<{job_id?:string}>).some((job) => job.job_id === jobId)).toBe(false);
      const logs = await mcpTool("job", { action: "logs", workspace_id: "workspace-1", job_id: jobId, stream: "stdout", limit: 1024 });
      expect(logs.structuredContent?.data).toContain("batched-live-log");
    } finally { expect((await save("immediate")).status).toBe(303); }
  });

  it("R03 reads three real commits and literal blame through MCP without shell permission", async () => {
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
    git(["init"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    const file = "review-history.txt";
    for (const value of ["first", "second", "third"]) {
      await writeFile(join(workspace, file), `${value}\nunchanged\n`);
      git(["add", "-f", "--", file]); git(["commit", "-m", value, "--", file]);
    }
    const history = await mcpTool("inspect", { action: "git_log", workspace_id: "workspace-1", path: file, max_results: 10 }, clientB);
    expect(history.isError, JSON.stringify(history)).not.toBe(true);
    expect((history.structuredContent?.commits as Array<{subject:string}>).map(row => row.subject)).toEqual(["third", "second", "first"]);
    expect(history.structuredContent?.truncated).toBe(false);
    const blamed = await mcpTool("inspect", { action: "git_blame", workspace_id: "workspace-1", path: file, start_line: 1, end_line: 2 }, clientB);
    expect(blamed.isError, JSON.stringify(blamed)).not.toBe(true);
    expect(blamed.structuredContent?.output).toContain("\tthird");
  });

  it("R04 retains one checkpoint revision for repeated observed Job evidence across real MCP calls", async () => {
    const started = await mcpTool("shell", { workspace_id: "workspace-1", command: nodeCommand("process.stdout.write('observed-evidence')") });
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    const id = started.structuredContent?.job_id;
    expect(typeof id).toBe("string");
    const input = { action: "checkpoint", workspace_id: "workspace-1", turn_id: "e2e-observed-retry", goal: "retain one observed checkpoint", expected_revision: 0, evidence: [{ kind: "job", job_id: id }] };
    const first = await mcpTool("context", input);
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    await delay(25);
    const next = await mcpTool("context", input);
    expect(next.isError, JSON.stringify(next)).not.toBe(true);
    expect(next.structuredContent?.deduplicated).toBe(true);
    expect((next.structuredContent?.context as { revision: number }).revision).toBe(1);
    expect((next.structuredContent?.context as { evidence: unknown }).evidence).toEqual((first.structuredContent?.context as { evidence: unknown }).evidence);
  });

  it("reports a runner_offline structured error after the real runner disconnects", async () => {
    await stop(runner); runner = undefined;
    // Close handling is asynchronous across the runner socket and DO.
    await delay(200);
    const offline = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 1 });
    expect(offline).toMatchObject({ isError: true, structuredContent: { error: { code: "runner_offline" } } });
  });

  async function createBrowserRunnerEnrollment(): Promise<string> {
    const { adminJar, csrf } = await adminCredentials();
    const response = await submitForm("/admin/runners", { csrf_token: csrf, display_name: "Enrollment E2E Runner", runner_id: runnerId, execution_mode: "dedicated_user" }, adminJar);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Manual portable-artifact enrollment");
    expect(html).toContain("Manual Runner enrollment and install");
    expect(html).toContain("RUNNER=/opt/runmesh/current/bin/runmesh");
    expect(html).toContain("C:\\Program Files\\Runmesh\\current\\runmesh.cmd");
    expect(html).toContain('sudo &quot;$RUNNER&quot; enroll');
    expect(html).toContain('&amp; $RunnerPath enroll');
    expect(html).toContain('sudo &quot;$RUNNER&quot; install');
    expect(html).toContain('&amp; $RunnerPath install');
    expect(html).toContain("--code-stdin");
    expect(html).toContain("--executable-path");
    expect(html).not.toContain("curl -fsSL");
    expect(html).not.toContain("curl --fail --location");
    expect(html).not.toContain("Invoke-WebRequest");
    const code = /<span class="form-stat-label">One-time enrollment code<\/span><code class="mono" data-no-i18n>([A-Za-z0-9_-]{43})<\/code>/.exec(html)?.[1];
    if (code === undefined) throw new Error("browser enrollment code absent");
    // The one-time code is rendered in its own protected value block and must
    // never be embedded in either platform's copied command.
    expect(html).not.toMatch(new RegExp(`--code(?:=|\\s+)${code}`, "u"));
    return code;
  }
  async function setupAdminAndClients(): Promise<{ readonly clientA: McpClient; readonly clientB: McpClient }> {
    const setupPage = await fetch(`${workerUrl}/`, { redirect: "manual" });
    expect(setupPage.status).toBe(200);
    const setupHtml = await setupPage.text();
    const setupCsrf = formToken(setupHtml);
    const setupCookie = cookieFrom(setupPage, "__Host-runmesh_setup_csrf");
    const setup = await submitForm("/setup", {
      csrf_token: setupCsrf, password: adminPassword, confirm_password: adminPassword,
    }, cookieJar([["__Host-runmesh_setup_csrf", setupCookie]]));
    expect(setup.status).toBe(303);

    const loginPage = await fetch(`${workerUrl}/`, { redirect: "manual" });
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    const loginCsrf = formToken(loginHtml);
    const loginCookie = cookieFrom(loginPage, "__Host-runmesh_login_csrf");
    const login = await submitForm("/login", { csrf_token: loginCsrf, password: adminPassword }, cookieJar([["__Host-runmesh_login_csrf", loginCookie]]));
    expect(login.status).toBe(303);
    const session = cookieFrom(login, "__Host-runmesh_admin_session");
    const csrf = cookieFrom(login, "__Host-runmesh_admin_csrf");
    const adminJar = cookieJar([["__Host-runmesh_admin_session", session], ["__Host-runmesh_admin_csrf", csrf]]);

    const clientA = await createMcpClient("Client A E2E", ["coding:read", "coding:write", "coding:exec"], adminJar, csrf);
    const clientB = await createMcpClient("Client B E2E", ["coding:read"], adminJar, csrf);
    expect(clientA.endpoint).not.toBe(clientB.endpoint);
    return { clientA, clientB };
  }

  async function createMcpClient(label: string, scopes: readonly string[], adminJar: CookieJar, csrf: string): Promise<McpClient> {
    const response = await submitForm("/admin/clients", { csrf_token: csrf, label, scopes }, adminJar);
    expect(response.status).toBe(200);
    const endpoint = oneTimeMcpUrl(await response.text());
    return { endpoint };
  }

  async function mcpTool(name: string, args: Record<string, unknown>, client = clientA): Promise<ToolResult> {
    const message = await mcpMessage(name, args, client);
    if (message.result?.isError === true) console.error(`E2E MCP ${name}:`, JSON.stringify(message.result.structuredContent));
    if (message.error) throw new Error(message.error.message ?? "MCP JSON-RPC error");
    return message.result ?? {};
  }

  async function mcpMessage(name: string, args: Record<string, unknown>, client = clientA): Promise<JsonRpc> {
    if (client === undefined) throw new Error("MCP client setup did not complete");
    const response = await fetch(client.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(response.status).toBe(200);
    return readMcp(response);
  }

  async function adminCredentials(): Promise<{ readonly adminJar: CookieJar; readonly csrf: string }> {
    const loginPage = await fetch(`${workerUrl}/`, { redirect: "manual" });
    const loginCsrf = formToken(await loginPage.text());
    const loginCookie = cookieFrom(loginPage, "__Host-runmesh_login_csrf");
    const login = await submitForm("/login", { csrf_token: loginCsrf, password: adminPassword }, cookieJar([["__Host-runmesh_login_csrf", loginCookie]]));
    expect(login.status).toBe(303);
    const csrf = cookieFrom(login, "__Host-runmesh_admin_csrf");
    return { adminJar: cookieJar([["__Host-runmesh_admin_session", cookieFrom(login, "__Host-runmesh_admin_session")], ["__Host-runmesh_admin_csrf", csrf]]), csrf };
  }

  async function submitForm(path: string, fields: FormFields, cookies: CookieJar): Promise<Response> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string") body.set(key, value);
      else for (const item of value) body.append(key, item);
    }
    const encodedBody = body.toString();
    const bodyBytes = new TextEncoder().encode(encodedBody);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bodyBytes); controller.close(); } });
    return fetch(`${workerUrl}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: workerUrl, cookie: cookieHeader(cookies) },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }
});

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new Error("could not allocate a TCP port")); return; }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
}

async function readMcp(response: Response): Promise<JsonRpc> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as JsonRpc;
  const data = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
  if (data === undefined) throw new Error(`MCP response did not contain data: ${text}`);
  return JSON.parse(data) as JsonRpc;
}
function nodeCommand(script: string): string {
  // The shell RPC intentionally exercises the host shell. JSON.stringify is
  // valid command-line quoting for POSIX shells, but PowerShell treats the
  // resulting backslash-escaped Windows path as a literal (invalid) path and
  // parses `-e` as a separate expression. Use PowerShell's single-quote
  // escaping on Windows so the same fixture invokes Node on both platforms.
  if (process.platform === "win32") return `& ${powerShellQuote(process.execPath)} -e ${powerShellQuote(script)}`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}
function powerShellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function formToken(html: string): string {
  const token = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  if (token === undefined) throw new Error("CSRF token absent");
  return token;
}
function oneTimeMcpUrl(html: string): string {
  const endpoint = /<code>(https?:\/\/[^<]+\/[A-Za-z0-9_-]{43}\/mcp)<\/code>/.exec(html)?.[1];
  if (endpoint === undefined) throw new Error("one-time MCP URL absent");
  return endpoint;
}
function cookieFrom(response: Response, name: string): string {
  const value = new RegExp(`${name}=([^;]+)`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (value === undefined) throw new Error(`cookie ${name} absent`);
  return value;
}
function cookieJar(entries: readonly (readonly [string, string])[]): CookieJar { return new Map(entries); }
function cookieHeader(cookies: CookieJar): string { return [...cookies].map(([name, value]) => `${name}=${value}`).join("; "); }
function workerVars(): string[] { return Object.entries(workerEnv).flatMap(([name, value]) => ["--var", `${name}:${value}`]); }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout: number, detail: (() => string) | undefined = undefined): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  const output = detail?.() ?? "";
  throw new Error(`timed out after ${timeout}ms${output ? `\n${output}` : ""}`);
}
async function waitForWorker(detail: () => string): Promise<void> { await waitFor(async () => (await fetch(`${workerUrl}/health`).catch(() => undefined))?.ok === true, 60_000, detail); }
async function waitForExit(child: ChildProcess, timeout: number, detail: () => string): Promise<void> {
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(timeout).then(() => { throw new Error(`process did not exit after ${timeout}ms\n${detail()}`); }),
  ]);
}

function collectOutput(child: ChildProcess): () => string {
  let output = "";
  const collect = (chunk: Buffer | string): void => { output = `${output}${chunk.toString()}`.slice(-8_192); };
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  return () => output;
}
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.killed) return;
  if (child.pid !== undefined && process.platform === "win32") {
    // npx.cmd launches a cmd.exe/Node process tree on Windows. Killing only
    // the shell wrapper leaves Wrangler/Runner descendants alive and keeps
    // the temp persistence directory locked, causing EBUSY in afterAll.
    try {
      const { spawnSync } = await import("node:child_process");
      if (trustedTaskkill === undefined) throw new Error("trusted Windows taskkill path is unavailable");
      spawnSync(trustedTaskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { child.kill("SIGTERM"); }
  } else {
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(5_000)]);
  if (child.exitCode === null && !child.killed) {
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
