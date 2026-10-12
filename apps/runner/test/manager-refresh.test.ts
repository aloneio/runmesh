import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactRunnerRelease } from "@aloneio/runmesh-protocol";
import { renderService, serviceLayout, serviceProfilePath, type ServicePlatform } from "../src/service.js";
import { maintenanceManagerLayout, renderMaintenanceManager, type MaintenanceManagerFileStat, type MaintenanceManagerFilesystem } from "../src/updates/manager-install.js";
import { refreshMaintenanceManager, type ManagerRefreshDependencies, type ManagerRefreshNativeState, type ManagerRefreshOptions } from "../src/updates/manager-refresh.js";

const target = "0.1.9", previous = "0.1.8";
const nextBundle = `console.log("${target}");\n`, oldBundle = `console.log("${previous}");\n`;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function archive(entries: { name: string; value: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.value), header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8"); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}
function signedRelease(nodeMajor = 22, bundle = nextBundle, version = target) {
  const release = exactRunnerRelease(version), bytes = archive([
    { name: "package/package.json", value: JSON.stringify({ name: "@aloneio/runmesh-runner", version, dependencies: {} }) },
    { name: "package/dist/maintenance.cjs", value: bundle },
  ]);
  const manifest = Buffer.from(JSON.stringify({ schema_version: 1, project: "runmesh", version, tag: release.tag, channel: release.channel,
    prerelease: release.channel === "dev", commit_sha: "a".repeat(40), protocol_min: 2, protocol_max: 2, published_at: "2026-10-06T00:00:00Z",
    artifacts: [{ name: release.artifact_name, platform: "node", architecture: "portable", node_major_min: nodeMajor, url: release.artifact_url, size: bytes.length, sha256: digest(bytes) }] }));
  const key = generateKeyPairSync("ed25519"), trust = { key_id: "refresh-test", public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }).toString() };
  return { trust, assets: new Map<string, Buffer>([
    ["manifest.json", manifest], ["manifest.sig", Buffer.from(sign(null, manifest, key.privateKey).toString("base64"))],
    ["manifest.signature.json", Buffer.from(JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: trust.key_id, encoding: "base64", signed_file: "manifest.json" }))],
    [release.artifact_name, bytes],
  ]) };
}

function fixture(platform: ServicePlatform = "win32", state: ManagerRefreshNativeState = { registered: true, active: true, enabled: true, enablement: "enabled" }) {
  const layout = serviceLayout({ platform, mode: "system" });
  const options: ManagerRefreshOptions = { platform, mode: "system", profilePath: serviceProfilePath(layout), installRoot: layout.installRoot, uid: 0,
    releaseDirectory: platform === "win32" ? "C:\\release-assets" : "/release-assets" };
  const paths = maintenanceManagerLayout(options), files = new Map<string, Buffer>(), stats = new Map<string, MaintenanceManagerFileStat>();
  const events: string[] = [], faults = new Map<string, Error>(), actions = new Map<string, () => void>();
  let held = false, busy = false, native = { ...state };
  const signal = (event: string) => { events.push(event); actions.get(event)?.(); const failure = faults.get(event); if (failure !== undefined) { faults.delete(event); throw failure; } };
  const directory = (path: string) => {
    let part = path;
    while (true) { stats.set(part, { file: false, directory: true, symlink: false, uid: 0, mode: 0o755 }); const parent = paths.path.dirname(part); if (parent === part) break; part = parent; }
  };
  const file = (path: string, content: string | Uint8Array) => { directory(paths.path.dirname(path)); files.set(path, Buffer.from(content)); stats.set(path, { file: true, directory: false, symlink: false, uid: 0, mode: 0o600 }); };
  directory(layout.installRoot); directory(paths.managerRoot); directory(paths.path.join(paths.managerRoot, "state"));
  file(layout.manifestPath, renderService({ platform, mode: "system" }).content);
  file(options.profilePath, "existing profile bytes\n");
  file(paths.manifestPath, renderMaintenanceManager(options).content);
  file(paths.runtimePath, "retained runtime bytes"); file(paths.bundlePath, oldBundle);
  file(paths.path.join(paths.managerRoot, "installation.json"), JSON.stringify({ schema_version: 1, platform, mode: "system", profile_path: options.profilePath, install_root: layout.installRoot }));
  file(paths.path.join(paths.managerRoot, "state", "manager-id.json"), '{"schema_version":1,"manager_id":"manager_original"}\n');
  file(paths.path.join(paths.managerRoot, "state", "last-operation.json"), '{"previous":"completed receipt"}\n');
  file(paths.path.join(paths.managerRoot, "uninstall.ps1"), "retained helper bytes\n");
  file(paths.path.join(layout.stateRoot, "job-history.json"), "existing jobs\n");
  file(paths.path.join(layout.installRoot, "current"), "original selected Runner link");
  stats.set(paths.path.join(layout.installRoot, "current"), { file: false, directory: true, symlink: true, uid: 0, mode: 0o755 });
  const release = signedRelease();
  for (const [name, bytes] of release.assets) file(paths.path.join(options.releaseDirectory, name), bytes);
  const entry = paths.path.join(options.releaseDirectory, "external", "maintenance.cjs"), runtime = paths.path.join(options.releaseDirectory, "external", platform === "win32" ? "node.exe" : "node");
  file(entry, nextBundle); file(runtime, "external trusted runtime");
  const filesystem: MaintenanceManagerFilesystem = {
    read: async path => files.get(path)?.toString("utf8"), stat: async path => stats.get(path), realpath: async path => path,
    mkdir: async path => { signal(`mkdir:${path}`); directory(path); },
    write: async (path, content) => { signal(`write:${path}`); if (stats.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); file(path, content); },
    copy: async (source, destination) => { signal(`copy:${destination}`); if (stats.has(destination)) throw new Error("exists"); file(destination, files.get(source)!); },
    rename: async (source, destination) => { signal(destination === paths.bundlePath ? "replace-bundle" : `rename:${destination}`); const value = files.get(source); if (value === undefined) throw new Error("missing rename source"); file(destination, value); files.delete(source); stats.delete(source); },
    remove: async path => { signal(path === paths.path.join(layout.installRoot, ".manager-refresh.json") ? "remove-record" : `remove:${path}`); files.delete(path); stats.delete(path); },
    chmod: async () => undefined, symlink: async () => { throw new Error("refresh must not replace links"); },
  };
  const dependencies: ManagerRefreshDependencies = {
    version: target, trust: release.trust, invocation: { runtimePath: runtime, entryPath: entry },
    readBytes: async (path, limit) => {
      const value = files.get(path); if (value === undefined) throw Object.assign(new Error("missing file"), { code: "ENOENT" });
      if (value.length === 0 || value.length > limit || stats.get(path)?.symlink) throw new Error("invalid bounded fixture"); return Buffer.from(value);
    },
    durability: {
      create: async (path, content) => { signal("create-record"); await filesystem.write(path, content); signal("record-published"); },
      syncFile: async path => { signal(path === paths.bundlePath ? "sync-bundle" : path.endsWith(".manager-refresh.json") ? "sync-record" : "sync-private"); },
      syncDirectory: async () => { signal("sync-directory"); },
    },
    acquireLock: async () => {
      signal("acquire"); if (busy) return undefined; held = true;
      return { assertHeld: () => { if (!held) throw new Error("lease lost"); }, release: async () => { signal("release"); held = false; } };
    },
    native: {
      snapshot: async () => { signal("snapshot"); return { ...native }; },
      stop: async () => { signal("stop"); native = { ...native, active: false, enabled: false, enablement: "disabled", ...(platform === "darwin" ? { registered: false } : {}) }; signal("stopped"); },
      restore: async restored => { signal(files.get(paths.bundlePath)?.toString() === nextBundle ? "restore-new" : "restore-old"); native = { ...restored }; signal("restored"); },
    },
    probe: async (_runtime, bundle) => {
      if (bundle === undefined) return "v22.23.2";
      signal(bundle === paths.bundlePath ? files.get(bundle)?.toString() === nextBundle ? "probe-new" : "probe-old" : "probe-candidate");
      const bytes = files.get(bundle)?.toString(); if (bytes === nextBundle) return target; if (bytes === oldBundle) return previous; throw new Error("unknown probe program");
    },
  };
  const original = new Map([...files].filter(([path]) => !path.startsWith(options.releaseDirectory) && path !== paths.bundlePath).map(([path, value]) => [path, Buffer.from(value)]));
  return { options: { ...options, filesystem, executor: { execute: async () => ({ exitCode: 0 }) } }, dependencies, paths, files, stats, events, faults, actions, file, original,
    record: paths.path.join(layout.installRoot, ".manager-refresh.json"), active: paths.path.join(paths.managerRoot, "state", "active-operation.json"), entry,
    busy: () => { busy = true; }, loseLease: () => { held = false; }, nativeState: () => native };
}
function unchanged(test: ReturnType<typeof fixture>) { for (const [path, bytes] of test.original) expect(test.files.get(path), path).toEqual(bytes); }

describe("explicit independent manager refresh", () => {
  it.each(["linux", "darwin", "win32"] as const)("refreshes only the signed program on %s", async platform => {
    const test = fixture(platform), result = await refreshMaintenanceManager(test.options, test.dependencies);
    expect(result).toEqual({ action: "manager-refresh", manager_version: target, previous_manager_version: previous, runner_unchanged: true, restarted: true });
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(nextBundle); unchanged(test);
    expect(test.files.has(test.record)).toBe(false);
    expect(test.events.indexOf("sync-record")).toBeLessThan(test.events.indexOf("stop"));
    expect(test.events.indexOf("stopped")).toBeLessThan(test.events.indexOf("replace-bundle"));
    expect(test.events.filter(event => event === "replace-bundle")).toHaveLength(1);
    expect(test.events.at(-1)).toBe("release");
  });

  it.each([
    { registered: true, active: false, enabled: false, enablement: "disabled" as const },
    { registered: true, active: true, enabled: false, enablement: "disabled" as const },
  ])("restores the original Windows native policy %j", async state => {
    const test = fixture("win32", state), result = await refreshMaintenanceManager(test.options, test.dependencies);
    expect(test.nativeState()).toEqual(state); expect(result.restarted).toBe(state.active); unchanged(test);
  });

  it("does not restart a manager whose verified program already matches", async () => {
    const test = fixture(); test.file(test.paths.bundlePath, nextBundle);
    const result = await refreshMaintenanceManager(test.options, test.dependencies);
    expect(result.previous_manager_version).toBe(target); expect(result.restarted).toBe(false);
    expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("create-record");
  });

  it.each(["signature", "archive", "entry", "untrusted-key"])("rejects a mismatched %s before native mutation", async kind => {
    const test = fixture();
    if (kind === "signature") test.file(test.paths.path.join(test.options.releaseDirectory, "manifest.sig"), "a".repeat(88));
    if (kind === "archive") test.file(test.paths.path.join(test.options.releaseDirectory, exactRunnerRelease(target).artifact_name), "changed archive");
    if (kind === "entry") test.file(test.entry, "different executable entry");
    const dependencies = kind === "untrusted-key" ? { ...test.dependencies, trust: signedRelease().trust } : test.dependencies;
    await expect(refreshMaintenanceManager(test.options, dependencies)).rejects.toThrow();
    expect(test.events).not.toContain("acquire"); expect(test.events).not.toContain("stop"); unchanged(test);
  });

  it("rejects execution from the installed manager directory", async () => {
    const test = fixture();
    await expect(refreshMaintenanceManager(test.options, { ...test.dependencies,
      invocation: { runtimePath: test.paths.runtimePath, entryPath: test.entry } })).rejects.toThrow("outside");
    expect(test.events).not.toContain("acquire");
  });

  it("keeps a busy manager running", async () => {
    const test = fixture(); test.busy();
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow("maintenance is active");
    expect(test.events).toEqual(["acquire"]); unchanged(test);
  });

  it.each(["preparing", "claimed", "staged", "draining", "stopping", "switching", "starting", "checking", "rolling_back", "recovery_required", "succeeded", "failed", "rolled_back", "invalid-json", "link"])("retains an existing %s operation without stopping its manager", async phase => {
    const test = fixture(); test.file(test.active, phase === "invalid-json" ? "{" : JSON.stringify({ phase }));
    if (phase === "link") test.stats.set(test.active, { ...test.stats.get(test.active)!, symlink: true });
    const bytes = Buffer.from(test.files.get(test.active)!);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow("recorded Runner version operation");
    expect(test.events).not.toContain("stop"); expect(test.files.get(test.active)).toEqual(bytes); unchanged(test);
  });

  it("rejects an installation identity mismatch before stopping", async () => {
    const test = fixture(); test.file(test.paths.path.join(test.paths.managerRoot, "installation.json"), "another installation");
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow("different installation");
    expect(test.events).not.toContain("stop");
  });

  it("rejects a linked state directory before stopping", async () => {
    const test = fixture(), state = test.paths.path.join(test.paths.managerRoot, "state");
    test.stats.set(state, { ...test.stats.get(state)!, symlink: true });
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow("linked");
    expect(test.events).not.toContain("stop");
  });

  it("checks the signed Node floor before preparing a manager replacement", async () => {
    const test = fixture(), release = signedRelease(24);
    for (const [name, bytes] of release.assets) test.file(test.paths.path.join(test.options.releaseDirectory, name), bytes);
    const refresh = refreshMaintenanceManager(test.options, { ...test.dependencies, trust: release.trust });
    if (Number(process.versions.node.split(".")[0]) >= 24) {
      await expect(refresh).rejects.toThrow("retained manager runtime does not satisfy the signed maintenance package");
      expect(test.events).toContain("acquire");
    } else {
      await expect(refresh).rejects.toThrow("release manifest does not match the requested maintenance package");
      expect(test.events).not.toContain("acquire");
    }
    expect(test.events).not.toContain("snapshot"); expect(test.events).not.toContain("stop"); expect(test.events).not.toContain("create-record");
  });

  it.each(["stop", "replace-bundle", "probe-new", "restore-new"])("restores the previous program and native policy after %s fails", async boundary => {
    const test = fixture(), originalError = new Error(`${boundary} fixture`); test.faults.set(boundary, originalError);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBe(originalError);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(oldBundle);
    expect(test.nativeState()).toEqual({ registered: true, active: true, enabled: true, enablement: "enabled" });
    expect(test.files.has(test.record)).toBe(false); unchanged(test);
  });

  it("retains both errors and recovery files when restoring the previous manager fails", async () => {
    const test = fixture(), originalError = new Error("new manager startup"), recoveryError = new Error("old manager startup");
    test.faults.set("restore-new", originalError); test.faults.set("restore-old", recoveryError);
    const failure = await refreshMaintenanceManager(test.options, test.dependencies).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([originalError, recoveryError]);
    expect(failure.cause).toBe(originalError); expect(test.files.has(test.record)).toBe(true);
    expect([...test.files.keys()].some(path => path.endsWith(".previous.cjs"))).toBe(true); unchanged(test);
  });

  it("stops mutation after losing the installation lease", async () => {
    const test = fixture(); test.actions.set("stopped", test.loseLease);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBeInstanceOf(AggregateError);
    expect(test.events.slice(test.events.indexOf("stopped") + 1)).toEqual(["release"]);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(oldBundle); expect(test.files.has(test.record)).toBe(true); unchanged(test);
  });

  it.each(["stopped", "sync-bundle", "restored"])("resumes an interrupted refresh after %s using the recorded hashes", async boundary => {
    const test = fixture(); test.actions.set(boundary, test.loseLease);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBeInstanceOf(AggregateError);
    expect(test.files.has(test.record)).toBe(true); const saved = Buffer.from(test.files.get(test.record)!);
    test.actions.clear();
    const result = await refreshMaintenanceManager(test.options, test.dependencies);
    expect(result.previous_manager_version).toBe(previous); expect(result.manager_version).toBe(target);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(nextBundle); expect(test.files.has(test.record)).toBe(false);
    expect(JSON.parse(saved.toString()).previous_sha256).toBe(digest(oldBundle)); unchanged(test);
  });

  it("retains a recovery record when another program replaces the manager", async () => {
    const test = fixture(); test.actions.set("stopped", test.loseLease);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow(); test.actions.clear();
    test.file(test.paths.bundlePath, "another program"); const before = test.events.filter(event => event === "stop").length;
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toThrow();
    expect(test.events.filter(event => event === "stop")).toHaveLength(before);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe("another program"); expect(test.files.has(test.record)).toBe(true);
  });

  it("leaves only private preparation files when candidate verification fails", async () => {
    const test = fixture(), failure = new Error("candidate version"); test.faults.set("probe-candidate", failure);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBe(failure);
    expect(test.events).not.toContain("stop"); expect(test.files.has(test.record)).toBe(false);
    expect([...test.files.keys()].filter(path => /\.refresh-[a-f0-9-]+\.(previous|next)\.cjs$/u.test(path))).toHaveLength(2);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(oldBundle); unchanged(test);
  });

  it("does not roll back a committed manager when recovery-record cleanup fails", async () => {
    const test = fixture(), failure = new Error("record cleanup"); test.faults.set("remove-record", failure);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBe(failure);
    expect(test.events.filter(event => event === "stop")).toHaveLength(1);
    expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(nextBundle); expect(test.files.has(test.record)).toBe(true);
    expect(test.nativeState().active).toBe(true); unchanged(test);
  });

  it("keeps the committed program after record removal and a directory-sync failure", async () => {
    const test = fixture(), failure = new Error("directory sync"); test.faults.set("sync-directory", failure);
    await expect(refreshMaintenanceManager(test.options, test.dependencies)).rejects.toBe(failure);
    expect(test.events.filter(event => event === "stop")).toHaveLength(1);
    expect(test.files.has(test.record)).toBe(false); expect(test.files.get(test.paths.bundlePath)?.toString()).toBe(nextBundle);
    expect([...test.files.keys()].some(path => path.endsWith(".previous.cjs"))).toBe(true); unchanged(test);
  });

  it("preserves the original failure when releasing the lease also fails", async () => {
    const test = fixture(), failure = new Error("candidate probe"), release = new Error("lease release");
    test.faults.set("probe-candidate", failure); test.faults.set("release", release);
    const result = await refreshMaintenanceManager(test.options, test.dependencies).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError); expect(result.errors).toEqual([failure, release]); expect(result.cause).toBe(failure);
  });

  it.runIf(process.platform === "win32")("flushes and atomically replaces real Windows files without changing the private runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "runmesh-refresh-files-")), previousLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join(root, "LocalAppData");
    try {
      const layout = serviceLayout({ platform: "win32", mode: "user" }), releaseDirectory = join(root, "release"), entry = join(root, "maintenance.cjs");
      const options: ManagerRefreshOptions = { platform: "win32", mode: "user", profilePath: serviceProfilePath(layout), installRoot: layout.installRoot, releaseDirectory };
      const paths = maintenanceManagerLayout(options), release = signedRelease();
      for (const directory of [layout.installRoot, join(paths.managerRoot, "runtime"), join(paths.managerRoot, "state"), releaseDirectory]) await mkdir(directory, { recursive: true });
      await writeFile(layout.manifestPath, renderService({ platform: "win32", mode: "user" }).content);
      await writeFile(options.profilePath, "existing profile bytes");
      await writeFile(paths.manifestPath, renderMaintenanceManager(options).content);
      await writeFile(paths.runtimePath, "retained runtime bytes"); await writeFile(paths.bundlePath, oldBundle);
      await writeFile(join(paths.managerRoot, "installation.json"), JSON.stringify({ schema_version: 1, platform: "win32", mode: "user", profile_path: options.profilePath, install_root: layout.installRoot }));
      await writeFile(join(paths.managerRoot, "state", "manager-id.json"), "existing manager identity");
      await writeFile(entry, nextBundle);
      for (const [name, bytes] of release.assets) await writeFile(join(releaseDirectory, name), bytes);
      let held = false, active = true;
      const result = await refreshMaintenanceManager(options, { version: target, trust: release.trust, invocation: { runtimePath: process.execPath, entryPath: entry },
        acquireLock: async () => { held = true; return { assertHeld: () => { if (!held) throw new Error("lease lost"); }, release: async () => { held = false; } }; },
        native: { snapshot: async () => ({ registered: true, active, enabled: true, enablement: "enabled" }), stop: async () => { active = false; }, restore: async state => { active = state.active; } },
        probe: async (_runtime, bundle) => bundle === undefined ? "v22.23.2" : (await readFile(bundle, "utf8")) === nextBundle ? target : previous,
      });
      expect(result.manager_version).toBe(target); expect(active).toBe(true); expect(held).toBe(false);
      expect(await readFile(paths.bundlePath, "utf8")).toBe(nextBundle);
      expect(await readFile(paths.runtimePath, "utf8")).toBe("retained runtime bytes");
      expect(await readFile(join(paths.managerRoot, "state", "manager-id.json"), "utf8")).toBe("existing manager identity");
      await expect(readFile(join(layout.installRoot, ".manager-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
