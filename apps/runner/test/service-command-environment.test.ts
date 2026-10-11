import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostServiceCommandExecutor } from "../src/services/command-executor.js";
import { assertSystemInstallationPrivilege } from "../src/cli/service-plan.js";
import { renderService } from "../src/service.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../src/windows-tools.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/windows-tools.js")>(), trustedWindowsRoot: () => "C:\\Windows" }));

const hostProcess = process;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };

beforeEach(() => {
  vi.stubGlobal("process", {
    ...hostProcess,
    platform: "linux",
    getuid: () => 1000,
    geteuid: () => 1234,
    env: {
      ...hostProcess.env,
      PATH: "/tmp/operator-tools",
      XDG_RUNTIME_DIR: "/tmp/operator-runtime",
      DBUS_SESSION_BUS_ADDRESS: "tcp:host=remote.example,port=1234",
      LD_PRELOAD: "/tmp/operator-loader.so",
      NODE_OPTIONS: "--require=/tmp/operator-hook.cjs",
    },
  });
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function environmentFor(file: string, args: readonly string[]): Promise<NodeJS.ProcessEnv> {
  const result = hostServiceCommandExecutor.execute(file, args);
  child.emit("close", 0);
  await expect(result).resolves.toMatchObject({ exitCode: 0 });
  return vi.mocked(spawn).mock.calls[0]![2]!.env!;
}

it.each([0, 1234])("connects Linux user service commands to effective UID %i's local runtime", async uid => {
  vi.stubGlobal("process", { ...process, geteuid: () => uid });
  const environment = await environmentFor("systemctl", ["--user", "is-active", "--quiet", "runmesh-runner.service"]);
  expect(environment).toEqual({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
  });
});

it.each([
  ["systemctl", ["stop", "runmesh-runner.service"]],
  ["id", ["--user", "runmesh"]],
] as const)("keeps %s host commands isolated from user-session and loader environment", async (file, args) => {
  const environment = await environmentFor(file, args);
  expect(environment).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
});

it("recognizes an elevated Windows token when the Server service is unavailable", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(spawnSync).mockImplementation((file, args) => {
    const status = /(?:^|\\)net(?:\.exe)?$/iu.test(file) ? 2 : 0;
    if (status === 0) expect(args?.at(-1)).toContain(".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    return { pid: 0, signal: null, output: [], stdout: Buffer.alloc(0), stderr: Buffer.from("System error 2114: The Server service is not started."), status };
  });
  expect(() => assertSystemInstallationPrivilege(renderService({ platform: "win32", mode: "system" }), {})).not.toThrow();
  const [executable, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(args?.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  expect(args?.at(-1)).toContain("[Security.Principal.WindowsIdentity]::GetCurrent()");
  expect(options).toMatchObject({ cwd: "C:\\Windows\\System32", timeout: 10_000, windowsHide: true, stdio: "ignore" });
  expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
  expect(options?.env?.Path).toBe("C:\\Windows\\System32;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
});

it.each([
  { name: "ordinary token", status: 1 },
  { name: "failed token query", status: 2 },
  { name: "unavailable token query", status: null },
])("rejects Windows system changes for an $name", ({ status }) => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(spawnSync).mockReturnValue({ pid: 0, signal: null, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status });
  expect(() => assertSystemInstallationPrivilege(renderService({ platform: "win32", mode: "system" }), {})).toThrow("administrator/root");
});

it("does not require a Windows administrator token for a user service", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  assertSystemInstallationPrivilege(renderService({ platform: "win32", mode: "user" }), {});
  expect(spawnSync).not.toHaveBeenCalled();
});
