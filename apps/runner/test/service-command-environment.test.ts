import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostServiceCommandExecutor } from "../src/services/command-executor.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

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
