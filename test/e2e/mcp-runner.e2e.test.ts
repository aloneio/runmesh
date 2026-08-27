import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

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
const adminToken = "e2e-admin-token-0123456789abcdef";
const adminPassword = "e2e-administrator-password";
const workerEnv = {
  ADMIN_TOKEN: adminToken,
  SETUP_TOKEN: "e2e-setup-token-0123456789abcdef",
  RUNNER_TOKEN_PEPPER: "e2e-runner-token-pepper-not-for-production",
  INTERNAL_CONTROL_SECRET: "e2e-internal-control-secret-not-for-production",
};

describe.sequential("real local MCP → Worker → Runner RPC", () => {
  let requestId = 10;
  let workspace = "";
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
    workerPersist = join(root, "wrangler-state");
    runnerState = join(root, "runner-state");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "note.txt"), "hello from a real local runner\n");
    await writeFile(join(workspace, "utf8.txt"), "Hello你好😀éWorld", "utf8");

    worker = spawn("npx", ["wrangler", "dev", "--local", "--config", "apps/worker/wrangler.jsonc", "--port", String(workerPort), "--persist-to", workerPersist, ...workerVars()], {
      cwd: projectRoot(), env: { ...process.env, ...workerEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const workerLog = collectOutput(worker);
    await waitForWorker(workerLog);
    const createdClients = await setupAdminAndClients();
    enrollmentCode = await createBrowserRunnerEnrollment();
    expect(enrollmentCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    clientA = createdClients.clientA;
    clientB = createdClients.clientB;

    // Exercise the real source CLI against the Worker enrollment endpoint using
    // its isolated profile, then start from that saved profile (no service manager).
    enrolledProfile = join(root, "enrolled-profile.json");
    const enrollmentCli = spawn("npx", ["tsx", "apps/runner/src/cli.ts", "enroll", "--server", `${workerUrl}/runner/enroll`, "--code", enrollmentCode, "--insecure-local", "--cwd", workspace, "--profile", enrolledProfile, "--json"], {
      cwd: projectRoot(), env: { ...process.env, CODING_RUNNER_PROFILE: enrolledProfile }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const enrollmentCliLog = collectOutput(enrollmentCli);
    await waitForExit(enrollmentCli, 15_000, enrollmentCliLog);
    expect(enrollmentCli.exitCode).toBe(0);
    expect(enrollmentCliLog()).not.toContain(enrollmentCode);
    const profile = await readFile(enrolledProfile, "utf8");
    expect(profile).toContain(`\"runner_id\": \"${runnerId}\"`);
    expect(profile).not.toContain(enrollmentCode);
    // Central policy is configured by the authenticated Panel. Enrollment and
    // Runner startup intentionally begin with zero workspaces.
    const savedProfile = JSON.parse(profile) as Record<string, unknown>;
    expect(savedProfile.workspaces).toEqual([]);

    runner = spawn("npx", [
      "tsx", "apps/runner/src/cli.ts", "start", "--state-dir", runnerState, "--disconnect-control-file", join(root, "disconnect"),
    ], {
      cwd: projectRoot(), env: { ...process.env, CODING_RUNNER_PROFILE: enrolledProfile }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    const runnerLog = collectOutput(runner);
    runnerOutput = runnerLog;
    const { adminJar: policyAdminJar, csrf: policyCsrf } = await adminCredentials();
    const runnerPermissionResponse = await submitForm(`/admin/runners/${runnerId}/permissions`, { csrf_token: policyCsrf, read: "true", edit: "true", shell: "true", job_control: "true" }, policyAdminJar);
    expect(runnerPermissionResponse.status).toBe(303);
    const workspaceResponse = await submitForm(`/admin/runners/${runnerId}/workspace-create`, { csrf_token: policyCsrf, workspace_id: "workspace-1", display_name: "Coding workspace", root_path: workspace, enabled: "true", profile: "coding", read: "true", edit: "true", shell: "true", job_control: "true" }, policyAdminJar);
    expect(workspaceResponse.status).toBe(303);
    const readonlyResponse = await submitForm(`/admin/runners/${runnerId}/workspace-create`, { csrf_token: policyCsrf, workspace_id: "readonly-1", display_name: "Read only workspace", root_path: workspace, enabled: "true", profile: "read_only", read: "true", edit: "false", shell: "false", job_control: "false" }, policyAdminJar);
    expect(readonlyResponse.status).toBe(303);
    await waitFor(async () => {
      const status = await fetch(`${workerUrl}/admin/runners/${runnerId}`, { headers: { cookie: cookieHeader(policyAdminJar) } });
      const html = await status.text();
      return html.includes("Policy status") && html.includes("applied");
    }, 15_000, runnerLog);
    expect((await mcpTool("runner_select", { runner_id: runnerId }, clientA)).isError).not.toBe(true);
    expect((await mcpTool("runner_select", { runner_id: runnerId }, clientB)).isError).not.toBe(true);
  }, 30_000);

  afterAll(async () => {
    await stop(runner); await stop(worker);
    if (root) await rm(root, { recursive: true, force: true });
  }, 15_000);

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
      body: JSON.stringify({ runner_id: otherRunnerId, token: "e2e-runner-secondary-token-0123456789" }),
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
    const listed = await readMcp(response) as { result?: { tools?: Array<{ name?: string }> } };
    expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual(["edit", "inspect", "job", "read", "runner_current", "runner_list", "runner_select", "shell", "workspace_list"].sort());
    const legacy = await mcpMessage("fs_read", { workspace_id: "workspace-1", path: "note.txt" });
    expect(legacy.error?.code).toBe(-32602);
  });

  it("routes read through the live WebSocket runner without exposing its root", async () => {
    const result = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 128 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ workspace_id: "workspace-1", path: "note.txt", data: "hello from a real local runner\n" });
    expect(JSON.stringify(result)).not.toContain(workspace);
  });

  it("paginates live filesystem UTF-8 reads without replacement characters", async () => {
    let cursor: string | undefined;
    let output = "";
    do {
      const page = await mcpTool("read", {
        workspace_id: "workspace-1", path: "utf8.txt", ...(cursor === undefined ? {} : { cursor }), limit: 4,
      });
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
      workspace_id: "workspace-1", command: nodeCommand("setTimeout(() => process.stdout.write('completed-after-cross-client-reconnect\\n'), 5000)"), background: true,
    }, clientA);
    const jobId = started.structuredContent?.job_id;
    expect(typeof jobId).toBe("string");

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
    runner = spawn("npx", [
      "tsx", "apps/runner/src/cli.ts", "start", "--state-dir", runnerState, "--disconnect-control-file", join(root, "disconnect"),
    ], {
      cwd: projectRoot(), env: { ...process.env, CODING_RUNNER_PROFILE: enrolledProfile }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    runnerOutput = collectOutput(runner);
    await waitFor(async () => (await mcpTool("runner_list", {}, clientA)).structuredContent?.runners?.some((item: { runner_id?: string; state?: string }) => item.runner_id === runnerId && item.state === "online"), 15_000, runnerOutput);
    await delay(5_200);
    const completedSnapshot = await mcpTool("job", { action: "get", job_id: jobId as string }, clientB);
    expect(completedSnapshot.structuredContent?.status).toBe("interrupted");

    const logs = await mcpTool("job", { action: "logs", job_id: jobId as string, stream: "stdout", limit: 1024 }, clientB);
    expect(logs.structuredContent?.data).toBe("");
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

  it("reports a runner_offline structured error after the real runner disconnects", async () => {
    await stop(runner); runner = undefined;
    // Close handling is asynchronous across the runner socket and DO.
    await delay(200);
    const offline = await mcpTool("read", { workspace_id: "workspace-1", path: "note.txt", limit: 1 });
    expect(offline).toMatchObject({ isError: true, structuredContent: { error: { code: "runner_offline" } } });
  });

  async function createBrowserRunnerEnrollment(): Promise<string> {
    const { adminJar, csrf } = await adminCredentials();
    const response = await submitForm("/admin/runners", { csrf_token: csrf, display_name: "Enrollment E2E Runner", runner_id: runnerId }, adminJar);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Manual portable-artifact enrollment");
    expect(html).toContain("coding-runner enroll");
    expect(html).not.toContain("curl -fsSL");
    const code = /--code ([A-Za-z0-9_-]{43})/.exec(html)?.[1];
    if (code === undefined) throw new Error("browser enrollment code absent");
    return code;
  }
  async function setupAdminAndClients(): Promise<{ readonly clientA: McpClient; readonly clientB: McpClient }> {
    const setupPage = await fetch(`${workerUrl}/`, { redirect: "manual" });
    expect(setupPage.status).toBe(200);
    const setupHtml = await setupPage.text();
    const setupCsrf = formToken(setupHtml);
    const setupCookie = cookieFrom(setupPage, "__Host-runmesh_setup_csrf");
    const setup = await submitForm("/setup", {
      csrf_token: setupCsrf, setup_token: workerEnv.SETUP_TOKEN, password: adminPassword, confirm_password: adminPassword,
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
    return fetch(`${workerUrl}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: workerUrl, cookie: cookieHeader(cookies) },
      body,
    });
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
function nodeCommand(script: string): string { return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`; }
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
function projectRoot(): string { return resolve(new URL("../..", import.meta.url).pathname); }
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout: number, detail: (() => string) | undefined = undefined): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  const output = detail?.() ?? "";
  throw new Error(`timed out after ${timeout}ms${output ? `\n${output}` : ""}`);
}
async function waitForWorker(detail: () => string): Promise<void> { await waitFor(async () => (await fetch(`${workerUrl}/health`).catch(() => undefined))?.ok === true, 15_000, detail); }
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
  try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(5_000)]);
  if (child.exitCode === null && !child.killed) {
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
