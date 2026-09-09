import type { Stats } from "node:fs";
import { dirname, sep } from "node:path";
import { expect, it } from "vitest";
import { purgeInstallation, purgeLayout, type PurgeFilesystem } from "../src/purge.js";
import { currentServicePlatform, renderService } from "../src/service.js";

function memoryHost(withManifest = true) {
  const platform = currentServicePlatform(); const layout = purgeLayout(platform, "system");
  const entries = new Map<string, { ino: number; dir: boolean; text: string }>(); let index = 1; let native = true;
  const calls: string[][] = [];
  function dir(path: string) {
    if (entries.has(path)) return;
    if (dirname(path) !== path) dir(dirname(path));
    entries.set(path, { ino: index++, dir: true, text: "" });
  }
  function file(path: string, text = "fixture") { dir(dirname(path)); entries.set(path, { ino: index++, dir: false, text }); }
  for (const path of layout.directories) { dir(path); file(path + sep + "fixture"); }
  if (withManifest) file(layout.manifestPath, renderService({ platform, mode: "system", executionMode: "privileged_host" }).content);
  if (platform === "linux") dir("/run/systemd/system");
  const io: PurgeFilesystem = {
    stat: async (path) => {
      const e = entries.get(path); if (!e) return undefined;
      return { dev: 1, ino: e.ino, mode: e.dir ? 0o40755 : 0o100644, uid: 0, isDirectory: () => e.dir, isFile: () => !e.dir, isSymbolicLink: () => false } as unknown as Stats;
    },
    canonical: async (path) => path,
    list: async (path) => [...entries.keys()].filter((p) => p !== path && dirname(p) === path).map((p) => p.slice(path.length + (path.endsWith(sep) ? 0 : 1))),
    text: async (path) => entries.get(path)?.text,
    link: async () => { throw new Error("unexpected link"); },
    file: async (path) => { entries.delete(path); },
    directory: async (path) => {
      if ([...entries.keys()].some((p) => p !== path && dirname(p) === path)) throw new Error("directory not empty");
      entries.delete(path);
    },
    mounts: async () => [],
  };
  const executor = { execute: async (program: string, args: readonly string[]) => {
    calls.push([program, ...args]);
    if (program === "powershell.exe") return { exitCode: 0, stdout: native ? "present" : "absent" };
    if (program === "schtasks") { if (args.includes("/Delete")) native = false; return { exitCode: 0, stdout: layout.installRoot }; }
    if (program === "launchctl") { if (args[0] === "bootout") { native = false; return { exitCode: 0 }; } return { exitCode: native ? 0 : 113, stdout: layout.installRoot }; }
    if (args.includes("--property=ActiveState")) return { exitCode: 0, stdout: "inactive" };
    if (args.includes("--property=LoadState")) return { exitCode: 0, stdout: "not-found" };
    return { exitCode: 0, stdout: "LoadState=loaded\nActiveState=inactive\nExecStart=path=" + (withManifest ? layout.installRoot + "/bin/runmesh" : "/unrelated/service") };
  } };
  return { platform, layout, entries, io, executor, calls };
}

it("cleans the current native layout with injected OS adapters", async () => {
  const host = memoryHost();
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.failures).toEqual([]); expect(result.purged).toBe(true);
  for (const root of host.layout.directories) expect(host.entries.has(root)).toBe(false);
  expect(host.entries.has(host.layout.manifestPath)).toBe(false);
});
it("does not stop an unrecognized native service when the manifest is missing", async () => {
  const host = memoryHost(false);
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(host.entries.has(host.layout.installRoot)).toBe(true);
  expect(host.calls.every((call) => !call.some((arg) => ["stop", "bootout", "/End", "/Delete"].includes(arg)))).toBe(true);
});
