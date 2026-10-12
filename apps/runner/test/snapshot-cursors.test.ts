import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, realpath, stat, utimes, open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { PathPolicy, type PathSnapshot } from "../src/path-policy.js";
import { FilesystemService } from "../src/filesystem.js";
import { JobManager } from "../src/jobs.js";
import { CursorCache, captureFile, boundPageRequest, fileObservation, observeLog, verifyLogGeneration } from "../src/bound-cursors.js";
import { exactFileStats, sameFileIdentity, sameSnapshotFileIdentity, snapshotIdentityKey, statIdentityKey } from "../src/file-identity.js";
import { sameRootIdentity } from "../src/root-identity.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bound-cursors-")); roots.push(root);
  await mkdir(join(root, "workspace"));
  const workspace = { workspaceId: "w", rootPath: await realpath(join(root, "workspace")), readonly: false, shell: true };
  const policy = new PathPolicy([workspace]);
  return { root, workspace, policy, files: new FilesystemService(policy), stateDir: join(root, "state") };
}
async function jobFixture() {
  const f = await fixture(); const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir });
  await manager.initialize(); const job = await manager.start({ workspace_id: "w", command: process.execPath, args: ["-e", ""] });
  await vi.waitFor(() => expect(manager.get(job.job_id).status).toBe("succeeded"), { timeout: 10000 });
  await manager.flushPersistence();
  return { ...f, manager, job, log: join(f.stateDir, "jobs", job.job_id, "stdout.log") };
}

function metadata(ino: bigint, dev = 1n): BigIntStats {
  const ns = 1_700_000_000_123_456_789n, date = new Date(Number(ns / 1_000_000n));
  return {
    dev, ino, mode: 0o100600n, nlink: 1n, uid: 0n, gid: 0n, rdev: 0n, size: 7n, blksize: 4096n, blocks: 1n,
    atimeMs: ns / 1_000_000n, mtimeMs: ns / 1_000_000n, ctimeMs: ns / 1_000_000n, birthtimeMs: ns / 1_000_000n,
    atimeNs: ns, mtimeNs: ns, ctimeNs: ns, birthtimeNs: ns, atime: date, mtime: date, ctime: date, birthtime: date,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isBlockDevice: () => false,
    isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  };
}

it.each(["inode", "device"] as const)("keeps distinct exact %s metadata when numeric values round together", field => {
  const first = 2n ** 53n, second = first + 1n;
  const left = exactFileStats(field === "inode" ? metadata(first) : metadata(7n, first));
  const right = exactFileStats(field === "inode" ? metadata(second) : metadata(7n, second));
  expect({ dev: left.dev, ino: left.ino }).toEqual({ dev: right.dev, ino: right.ino });
  const snapshot = (info: typeof left) => ({ device: info.dev, inode: info.ino, identityKey: info.identityKey });
  expect(sameSnapshotFileIdentity(snapshot(left), snapshot(right))).toBe(false);
  expect(sameSnapshotFileIdentity(snapshot(left), snapshot(left))).toBe(true);
  expect(fileObservation(left)).not.toBe(fileObservation(right));
  expect(sameRootIdentity({ canonical: "/workspace", ...snapshot(left) }, { canonical: "/workspace", ...snapshot(right) })).toBe(false);
  expect(JSON.parse(JSON.stringify(snapshot(left)))).toEqual(snapshot(left));
  expect(left.mtimeMs).toBe(1_700_000_000_000 + 123.456789);
  expect(left.mode).toBe(0o100600); expect(left.size).toBe(7); expect(left.isFile()).toBe(true);
});

it("accepts safe legacy identity fields while rejecting rounded or inconsistent snapshots", () => {
  expect(sameSnapshotFileIdentity({ device: 1, inode: 7 }, { device: 1, inode: 7, identityKey: "1:7" })).toBe(true);
  const info = exactFileStats(metadata(2n ** 53n));
  const legacy = { device: info.dev, inode: info.ino };
  expect(snapshotIdentityKey(legacy)).toBeUndefined();
  expect(sameSnapshotFileIdentity(legacy, { ...legacy, identityKey: info.identityKey })).toBe(false);
  expect(sameRootIdentity({ canonical: "/workspace", ...legacy }, { canonical: "/workspace", ...legacy, identityKey: info.identityKey })).toBe(false);
  expect(sameRootIdentity({ canonical: "/workspace", device: 1, inode: 7 }, { canonical: "/workspace", device: 1, inode: 7, identityKey: "1:7" })).toBe(true);
  expect(() => fileObservation({ ...info, identityKey: undefined } as unknown as typeof info)).toThrow(expect.objectContaining({ code: "file_changed" }));
  for (const identityKey of ["1:8", "01:7", "1:-7", "private", "1:" + "9".repeat(21)])
    expect(snapshotIdentityKey({ device: 1, inode: 7, identityKey })).toBeUndefined();
});

it("compares native bigint, exact projected and safe legacy file identities", () => {
  const native = metadata(2n ** 53n + 1n), projected = exactFileStats(native);
  expect(sameFileIdentity(native, projected)).toBe(true);
  expect(sameFileIdentity(native, { ...native, ino: native.ino - 1n })).toBe(false);
  expect(sameFileIdentity({ dev: 1, ino: 7 }, metadata(7n))).toBe(true);
  expect(sameFileIdentity({ dev: projected.dev, ino: projected.ino }, projected)).toBe(false);
  expect(statIdentityKey({ ...native, identityKey: "1:7" })).toBeUndefined();
  expect(statIdentityKey({ ...projected, identityKey: "1:7" })).toBeUndefined();
});

it.each(["inode", "device"] as const)("binds a log generation to exact %s metadata while allowing append", async field => {
  const first = 2n ** 53n, second = first + 1n;
  const before = exactFileStats(field === "inode" ? metadata(first) : metadata(7n, first));
  const changed = exactFileStats(field === "inode" ? metadata(second) : metadata(7n, second));
  const data = Buffer.from("prefix! appended");
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
    bytesRead: data.copy(buffer, offset, position, position + length),
  }));
  const handle = { read }, observed = await observeLog(handle, before);
  expect({ dev: before.dev, ino: before.ino }).toEqual({ dev: changed.dev, ino: changed.ino });
  read.mockClear();
  await expect(verifyLogGeneration(handle, changed, observed)).rejects.toMatchObject({ code: "log_changed" });
  expect(read).not.toHaveBeenCalled();
  await expect(verifyLogGeneration(handle, { ...before, size: data.length, mtimeMs: before.mtimeMs + 1 }, observed)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[2]).toBe(before.size);
});

it("log observations accept safe legacy metadata and reject imprecise identity before reading bytes", async () => {
  const read = vi.fn(async () => ({ bytesRead: 0 }));
  const safe = exactFileStats(metadata(7n)), { identityKey: _safeKey, ...safeLegacy } = safe;
  await expect(observeLog({ read }, { ...safeLegacy, size: 0 })).resolves.toMatchObject({ size: 0 });
  const exact = exactFileStats(metadata(2n ** 53n)), { identityKey: _exactKey, ...legacy } = exact;
  await expect(observeLog({ read }, legacy)).rejects.toMatchObject({ code: "log_changed" });
  expect(read).not.toHaveBeenCalled();
});

it.each(["leaf", "root"] as const)("rechecks exact %s identity and rejects an unsafe legacy snapshot", async boundary => {
  const policy = new PathPolicy([]), workspace = { workspaceId: "metadata", rootPath: "/workspace", readonly: true, shell: false };
  const first = 2n ** 53n, second = first + 1n;
  const base: PathSnapshot = { canonicalPath: "/workspace/file", rootCanonicalPath: "/workspace", device: 1, inode: 7,
    identityKey: "1:7", rootDevice: 1, rootInode: 9, rootIdentityKey: "1:9", type: "file", size: 7, modifiedAtMs: 0 };
  const identity = (ino: bigint): PathSnapshot => boundary === "leaf"
    ? { ...base, inode: Number(ino), identityKey: "1:" + ino }
    : { ...base, rootInode: Number(ino), rootIdentityKey: "1:" + ino };
  const observed = identity(second), expected = identity(first);
  vi.spyOn(policy, "snapshot").mockResolvedValue(observed);
  vi.spyOn(policy, "assertCurrentWorkspace").mockImplementation(() => undefined);
  const resolved = { workspace, path: "/workspace/file" };
  await expect(policy.verifySnapshot(resolved, observed)).resolves.toBeUndefined();
  await expect(policy.verifySnapshot(resolved, expected)).rejects.toMatchObject({ code: "path_changed" });
  const legacy = { ...observed };
  if (boundary === "leaf") delete (legacy as { identityKey?: string }).identityKey;
  else delete (legacy as { rootIdentityKey?: string }).rootIdentityKey;
  await expect(policy.verifySnapshot(resolved, legacy)).rejects.toMatchObject({ code: "path_changed" });
  vi.mocked(policy.snapshot).mockResolvedValue(base);
  const safeLegacy = { ...base }; delete (safeLegacy as { identityKey?: string }).identityKey; delete (safeLegacy as { rootIdentityKey?: string }).rootIdentityKey;
  await expect(policy.verifySnapshot(resolved, safeLegacy)).resolves.toBeUndefined();
});

it("R07 snapshot pages share a content hash and preserve CJK, emoji and CRLF", async () => {
  const f = await fixture(), text = "中😀\r\nabcé"; await writeFile(join(f.workspace.rootPath, "data.txt"), text);
  let page = await f.files.read({ workspace_id: "w", path: "data.txt", limit: 3, consistency: "snapshot" });
  const digest = createHash("sha256").update(text).digest("hex"); let combined = "", count = 0;
  while (true) {
    expect(page).toMatchObject({ page_protocol: 2, consistency: "snapshot", snapshot_id: digest });
    combined += page.data; expect(++count).toBeLessThan(12);
    if (page.next_cursor === null) break;
    expect(page.next_cursor).toMatch(/^f1:[a-f0-9]{64}:\d+$/);
    page = await f.files.read({ workspace_id: "w", path: "data.txt", limit: 3, cursor: page.next_cursor });
  }
  expect(combined).toBe(text); await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["replace", "overwrite"])("R07 file %s between pages invalidates the bound cursor", async change => {
  const f = await fixture(), path = join(f.workspace.rootPath, "data.txt"); await writeFile(path, "abcd");
  const page = await f.files.read({ workspace_id: "w", path: "data.txt", limit: 2, consistency: "snapshot" });
  if (change === "replace") { await rename(path, `${path}.old`); await writeFile(path, "wxyz"); }
  else { const before = await stat(path); await writeFile(path, "wxyz"); await utimes(path, before.atime, new Date(before.mtimeMs + 2000)); }
  await expect(f.files.read({ workspace_id: "w", path: "data.txt", cursor: page.next_cursor })).rejects.toMatchObject({ code: "file_changed" });
});

it("R07 snapshot cursors cannot be applied to another path or policy generation", async () => {
  const f = await fixture(); for (const name of ["a", "b"]) await writeFile(join(f.workspace.rootPath, name), "abcd");
  const page = await f.files.read({ workspace_id: "w", path: "a", limit: 2, consistency: "snapshot" });
  await expect(f.files.read({ workspace_id: "w", path: "b", cursor: page.next_cursor })).rejects.toMatchObject({ code: "cursor_mismatch" });
  f.policy.replace([f.workspace]);
  await expect(f.files.read({ workspace_id: "w", path: "a", cursor: page.next_cursor })).rejects.toMatchObject({ code: "cursor_mismatch" });
});

it("R07 snapshot admission is size-bounded while a large ordinary read remains available", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
  await expect(f.files.read({ workspace_id: "w", path: "large", limit: 2, consistency: "snapshot" })).rejects.toMatchObject({ code: "snapshot_too_large" });
  expect(await f.files.read({ workspace_id: "w", path: "large", limit: 2 })).toMatchObject({ data: "AA", next_cursor: "2", snapshot_id: null });
});

it("R07 append cursors survive growth and retain the original stream generation", async () => {
  const f = await jobFixture(); await writeFile(f.log, "abc");
  const first = await f.manager.logs(f.job.job_id, { limit: 2, consistency: "append" });
  expect(first).toMatchObject({ data: "ab", page_protocol: 2, consistency: "append" });
  await appendFile(f.log, "中😀");
  const next = await f.manager.logs(f.job.job_id, { cursor: first.next_cursor });
  expect(next).toMatchObject({ data: "c中😀", snapshot_id: first.snapshot_id, next_cursor: null });
  await appendFile(f.log, "more");
  expect(await f.manager.logs(f.job.job_id, { cursor: next.resume_cursor })).toMatchObject({ data: "more", snapshot_id: first.snapshot_id });
});

it.each(["rotate", "truncate", "truncate_regrow"])("R07 log %s must not join different sources", async change => {
  const f = await jobFixture(); await writeFile(f.log, "abcdefgh");
  const first = await f.manager.logs(f.job.job_id, { limit: 2, consistency: "append" });
  if (change === "rotate") { await rename(f.log, `${f.log}.old`); await writeFile(f.log, "replacement"); }
  else await writeFile(f.log, change === "truncate" ? "x" : "a completely replaced log bigger than the first");
  await expect(f.manager.logs(f.job.job_id, { cursor: first.next_cursor })).rejects.toMatchObject({ code: "log_changed" });
});

it("R07 bound log cursors cannot be reused for another output stream", async () => {
  const f = await jobFixture(); await writeFile(f.log, "abcd");
  const first = await f.manager.logs(f.job.job_id, { limit: 2, consistency: "append" });
  await expect(f.manager.logs(f.job.job_id, { stream: "stderr", cursor: first.next_cursor })).rejects.toMatchObject({ code: "cursor_mismatch" });
});

it("R07 partial UTF-8 can be explicitly resumed with its log-generation cursor", async () => {
  const f = await jobFixture(); await writeFile(f.log, Buffer.from([0xe4, 0xb8]));
  const first = await f.manager.logs(f.job.job_id, { consistency: "append" });
  expect(first).toMatchObject({ page_state: "incomplete", resume_offset: 0, page_protocol: 2 });
  expect(first.resume_cursor).toMatch(/^l1:[a-f0-9]{64}:0$/);
  await appendFile(f.log, Buffer.from([0xad]));
  expect(await f.manager.logs(f.job.job_id, { cursor: first.resume_cursor })).toMatchObject({ data: "中", page_state: "end", snapshot_id: first.snapshot_id });
});

it("R07 cache limits evict LRU entries and expiry is absolute, not extended by reads", () => {
  let clock = 100; vi.spyOn(performance, "now").mockImplementation(() => clock);
  const cache = new CursorCache<string>(2, 4, 100);
  const a = cache.put("a", "aa", 2), b = cache.put("b", "bb", 2);
  expect(cache.stats()).toEqual({ entries: 2, bytes: 4 });
  cache.get(a.id,"a"); const c = cache.put("c","cc",2);
  expect(() => cache.get(b.id,"b")).toThrow(expect.objectContaining({code:"cursor_expired"}));
  expect(() => cache.get(c.id,"other")).toThrow(expect.objectContaining({code:"cursor_mismatch"}));
  clock = 199; cache.get(a.id,"a"); clock = 200;
  expect(() => cache.get(a.id,"a")).toThrow(expect.objectContaining({code:"cursor_expired"}));
  expect(cache.stats()).toEqual({entries:0,bytes:0});
});

it("R07 an expired file cursor never falls back to its byte offset", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath,"a"),"abcd");
  const first = await f.files.read({workspace_id:"w",path:"a",limit:2,consistency:"snapshot"});
  const advanced = performance.now() + 300001; vi.spyOn(performance,"now").mockReturnValue(advanced);
  await expect(f.files.read({workspace_id:"w",path:"a",cursor:first.next_cursor})).rejects.toMatchObject({code:"cursor_expired"});
});

it("R07 revoked file read permission still applies to cached snapshot content", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath,"a"),"abcd");
  const first = await f.files.read({workspace_id:"w",path:"a",limit:2,consistency:"snapshot"});
  f.policy.replace([{...f.workspace,permissions:{read:false,edit:false,shell:false,job_control:false}}]);
  await expect(f.files.read({workspace_id:"w",path:"a",cursor:first.next_cursor})).rejects.toMatchObject({code:"permission_denied"});
});

it("R07 one snapshot reads source bytes once across 100 small pages", async () => {
  const f = await fixture(), path = join(f.workspace.rootPath,"a"), text="a".repeat(10000); await writeFile(path,text);
  const probe = await open(path,"r"); const prototype = Object.getPrototypeOf(probe), original=prototype.read;
  await probe.close(); let bytes = 0;
  vi.spyOn(prototype,"read").mockImplementation(async function(this:FileHandle,...args:any[]) { const result=await original.apply(this,args);bytes+=result.bytesRead;return result; });
  let page=await f.files.read({workspace_id:"w",path:"a",limit:100,consistency:"snapshot"}), combined=String(page.data), pages=1;
  while(page.next_cursor!==null) { page=await f.files.read({workspace_id:"w",path:"a",limit:100,cursor:page.next_cursor});combined+=page.data;pages++; }
  expect(combined).toBe(text);expect(pages).toBe(100);expect(bytes).toBe(10000);
  console.log(JSON.stringify({scenario:"snapshot_100_pages",source_bytes:bytes,source_size:10000,pages}));
});

it("R07 snapshot capture has global in-flight admission and bounded partial-read attempts", async () => {
  const f=await fixture(), path=join(f.workspace.rootPath,"a");await writeFile(path,"a");const info=exactFileStats(await stat(path,{bigint:true}));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const handle={read:async(buffer:Buffer)=>{await gate;buffer[0]=65;return {bytesRead:1,buffer};}};
  const pending=Array.from({length:4},()=>captureFile(handle,info));
  await expect(captureFile(handle,info)).rejects.toMatchObject({code:"busy"});release();await Promise.all(pending);
  const partial=vi.fn(async(buffer:Buffer,offset:number)=>{buffer[offset]=65;return {bytesRead:1,buffer};});
  await expect(captureFile({read:partial},{...info,size:65})).rejects.toMatchObject({code:"read_budget_exhausted"});
  expect(partial).toHaveBeenCalledTimes(64);
});

it("R07 direct RPC parameters cannot mix incompatible cursor modes", () => {
  for(const extra of [{cursor:`l1:${"a".repeat(64)}:2`},{cursor:`f1:${"a".repeat(64)}:2`,offset:2},{cursor:"2",consistency:"snapshot"},{consistency:"append"}]) expect(()=>boundPageRequest(extra,"file")).toThrow(expect.objectContaining({code:"invalid_params"}));
});

it("R07 log cursors require the current policy generation and expire after the fixed lifetime", async () => {
  const f=await jobFixture();await writeFile(f.log,"abcd");
  const first=await f.manager.logs(f.job.job_id,{consistency:"append",limit:2});
  f.policy.replace([f.workspace]);
  await expect(f.manager.logs(f.job.job_id,{cursor:first.next_cursor})).rejects.toMatchObject({code:"cursor_mismatch"});
  const fresh=await f.manager.logs(f.job.job_id,{consistency:"append",limit:2});
  const advanced=performance.now()+300001;vi.spyOn(performance,"now").mockReturnValue(advanced);
  await expect(f.manager.logs(f.job.job_id,{cursor:fresh.next_cursor})).rejects.toMatchObject({code:"cursor_expired"});
});

it("R07 bound metadata fits inside the serialized response budget for escaped file and log content", async () => {
  const f=await jobFixture(),text="\0中😀\r\n".repeat(10000);await writeFile(f.log,text);await writeFile(join(f.workspace.rootPath,"escaped"),text);
  const pages=[await f.files.read({workspace_id:"w",path:"escaped",consistency:"snapshot",limit:262144}),await f.manager.logs(f.job.job_id,{consistency:"append",limit:65536})];
  for(const page of pages) {
    expect(page).toMatchObject({page_protocol:2,page_state:"more",truncated_reason:"response_bytes"});
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48*1024);
    expect(Number(String(page.next_cursor).split(":")[2])).toBeGreaterThan(Number(page.offset));
  }
});

it("R07 bound log pages read at most two KiB of anchors, not the whole prior log", async () => {
  const f=await jobFixture();await writeFile(f.log,"a".repeat(1024*1024));
  const probe=await open(f.log,"r"),prototype=Object.getPrototypeOf(probe),original=prototype.read;await probe.close();let bytes=0;
  vi.spyOn(prototype,"read").mockImplementation(async function(this:FileHandle,...args:any[]) {const result=await original.apply(this,args);bytes+=result.bytesRead;return result;});
  const first=await f.manager.logs(f.job.job_id,{consistency:"append",limit:1024});expect(bytes).toBeLessThanOrEqual(1024+10+2048);
  bytes=0;const second=await f.manager.logs(f.job.job_id,{cursor:first.next_cursor,limit:1024});
  expect(second).toMatchObject({offset:1024,returned_bytes:1024,snapshot_id:first.snapshot_id});expect(bytes).toBeLessThanOrEqual(1024+10+2048);
  console.log(JSON.stringify({scenario:"bound_log_page",source_size:1024*1024,page_data_bytes:1024,actual_read_bytes:bytes}));
});
