import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runFixtureCommand } from "../scripts/worker-fixture.mjs";

const observerSource = await readFile(new URL("../scripts/worker-runtime-observer.mjs", import.meta.url), "utf8");
async function fixture(t, runtimeCommand = process.execPath) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-runtime-observer-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const nested = join(root, "node_modules/wrangler/node_modules");
  await mkdir(join(nested, "miniflare"), { recursive: true });
  await mkdir(join(nested, "workerd"), { recursive: true });
  await writeFile(join(root, "node_modules/wrangler/package.json"), JSON.stringify({ name: "wrangler" }));
  await writeFile(join(nested, "miniflare/package.json"), JSON.stringify({ name: "miniflare", main: "index.cjs" }));
  await writeFile(join(nested, "miniflare/index.cjs"), "module.exports = {};\n");
  await writeFile(join(nested, "workerd/package.json"), JSON.stringify({ name: "workerd", main: "index.cjs" }));
  await writeFile(join(nested, "workerd/index.cjs"), `module.exports = { default: ${JSON.stringify(runtimeCommand)} };\n`);
  const observer = join(root, "observer.mjs");
  await writeFile(observer, observerSource);
  return { root, observer, runtimeCommand };
}
async function execute(context, source, { extension = "mjs", preloads = [], env = {}, duplicate = false } = {}) {
  const entry = join(context.root, `entry.${extension}`);
  await writeFile(entry, source);
  const imports = [...preloads, context.observer, ...(duplicate ? [context.observer] : [])];
  const environment = { ...process.env, ...env };
  delete environment.NODE_OPTIONS;
  if (!Object.hasOwn(env, "MINIFLARE_WORKERD_PATH")) delete environment.MINIFLARE_WORKERD_PATH;
  return runFixtureCommand(process.execPath, [...imports.flatMap(file => ["--import", pathToFileURL(file).href]), entry], {
    cwd: context.root, timeout: 15_000, maxBuffer: 128 * 1024, env: environment,
  });
}
function diagnostics(stderr) {
  return stderr.split(/\r?\n/).filter(line => line.startsWith("RUNMESH_E2E_RUNTIME_")).map(line => JSON.parse(line.slice(line.indexOf("=") + 1)));
}
async function mockedSpawn(context) {
  const file = join(context.root, "mock-spawn.mjs");
  await writeFile(file, `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    const child = new EventEmitter(), failure = new Error('original-spawn-failure');
    globalThis.probe = { child, failure, calls: [] };
    childProcess.spawn = function (...args) {
      globalThis.probe.calls.push({ receiver: this, args });
      if (args[1]?.[0] === 'throw-original') throw failure;
      return child;
    };
  `);
  return file;
}

for (const extension of ["cjs", "mjs"]) test(`runtime observer covers a real ${extension.toUpperCase()} spawn and preserves its exit`, { timeout: 20_000 }, async t => {
  const context = await fixture(t);
  const imports = extension === "cjs" ? "const {spawn}=require('node:child_process');" : "import {spawn} from 'node:child_process';";
  const result = await execute(context, `${imports}
    const child=spawn(process.execPath,['-e','process.exit(17)'],{stdio:'ignore'});
    child.once('exit',code=>{if(code!==17)process.exitCode=1;});
  `, { extension, duplicate: true });
  const events = diagnostics(result.stderr);
  assert.deepEqual(events[0], { event: "runtime_observer", coverage: "installed" });
  assert.deepEqual(events.slice(1).map(({ elapsed_ms, ...value }) => value), [
    { event: "runtime_process", phase: "spawn", runtime_index: 1, exit_code: null, signal: null },
    { event: "runtime_process", phase: "exit", runtime_index: 1, exit_code: 17, signal: null },
  ]);
  assert.ok(events[2].elapsed_ms >= events[1].elapsed_ms && events[2].elapsed_ms <= 900_000);
  assert.ok(!result.stderr.includes(context.root));
});

test("runtime observer preserves spawn receiver, argument identities, return value, exceptions and error listeners", { timeout: 20_000 }, async t => {
  const context = await fixture(t), mock = await mockedSpawn(context);
  const result = await execute(context, `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    const receiver={}, args=['unchanged'], options={cwd:process.cwd(),stdio:'ignore'};
    const child=spawn.call(receiver,process.execPath,args,options);
    assert.equal(child,probe.child); assert.equal(probe.calls[0].receiver,receiver);
    assert.equal(probe.calls[0].args[1],args); assert.equal(probe.calls[0].args[2],options);
    assert.equal(child.listenerCount('error'),0);
    child.emit('spawn'); child.emit('exit',3010,null);
    assert.throws(()=>spawn(process.execPath,['throw-original']),error=>error===probe.failure);
  `, { preloads: [mock] });
  assert.deepEqual(diagnostics(result.stderr).filter(event => event.phase === "exit").map(event => event.exit_code), [3010]);
});

test("runtime observer leaves nonmatching commands untouched", { timeout: 20_000 }, async t => {
  const context = await fixture(t, join(tmpdir(), "private-unmatched-workerd.exe"));
  const result = await execute(context, `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','process.stdout.write("original-output")']);
    assert.equal(child.listenerCount('spawn'),0); assert.equal(child.listenerCount('error'),0);
    child.stdout.pipe(process.stdout); child.once('exit',code=>{if(code!==0)process.exitCode=1;});
  `);
  assert.equal(result.stdout, "original-output");
  assert.deepEqual(diagnostics(result.stderr), [{ event: "runtime_observer", coverage: "installed" }]);
});

test("runtime observer projects native exit codes and signals without private text", { timeout: 20_000 }, async t => {
  const context = await fixture(t), mock = await mockedSpawn(context);
  const cases = [[-2147483648, null], [4294967295, null], [3221225477, null], [null, "SIGTERM"], [null, "SIGKILL"], [4294967296, "private-signal"], ["private-code", undefined]];
  const result = await execute(context, `
    import {spawn} from 'node:child_process';
    for(const [code,signal] of ${JSON.stringify(cases)}) {
      const child=spawn(process.execPath,[]); child.emit('spawn'); child.emit('exit',code,signal);
    }
  `, { preloads: [mock] });
  const exits = diagnostics(result.stderr).filter(event => event.phase === "exit");
  assert.deepEqual(exits.map(({ exit_code, signal }) => ({ exit_code, signal })), [
    { exit_code: -2147483648, signal: null }, { exit_code: 4294967295, signal: null },
    { exit_code: 3221225477, signal: null }, { exit_code: null, signal: "SIGTERM" },
    { exit_code: null, signal: "SIGKILL" }, { exit_code: null, signal: "other" }, { exit_code: null, signal: null },
  ]);
  assert.ok(!result.stderr.includes("private"));
});

test("runtime observer bounds observed processes", { timeout: 20_000 }, async t => {
  const context = await fixture(t), mock = await mockedSpawn(context);
  const result = await execute(context, `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    for(let i=0;i<18;i++){const child=spawn(process.execPath,[]);child.emit('spawn');child.emit('exit',0,null);}
    const child=spawn(process.execPath,[]);assert.equal(child.listenerCount('error'),0);
  `, { preloads: [mock] });
  const events = diagnostics(result.stderr).filter(event => event.event === "runtime_process");
  assert.equal(events.length, 32);
  assert.deepEqual(events.filter(event => event.phase === "spawn").map(event => event.runtime_index), Array.from({ length: 16 }, (_, index) => index + 1));
});

test("runtime observer preserves asynchronous spawn errors without reporting a successful spawn", { timeout: 20_000 }, async t => {
  const context = await fixture(t, join(tmpdir(), "runmesh-runtime-observer-missing", "workerd.exe"));
  const result = await execute(context, `
    import assert from 'node:assert/strict';
    import {spawn} from 'node:child_process';
    const child=spawn(${JSON.stringify(context.runtimeCommand)},[]);
    assert.equal(child.listenerCount('error'),0);
    child.once('error',error=>{assert.equal(error.code,'ENOENT');process.stdout.write('original-error');});
  `);
  assert.equal(result.stdout, "original-error");
  assert.deepEqual(diagnostics(result.stderr), [{ event: "runtime_observer", coverage: "installed" }]);
});

for (const coverage of ["runtime_override", "resolution_failed"]) test(`runtime observer identifies ${coverage} coverage without changing the entrypoint`, { timeout: 20_000 }, async t => {
  const context = await fixture(t, coverage === "resolution_failed" ? "relative-private-runtime" : process.execPath);
  const result = await execute(context, "process.stdout.write('entry-ran');", { env: coverage === "runtime_override" ? { MINIFLARE_WORKERD_PATH: "private-override" } : {} });
  assert.equal(result.stdout, "entry-ran");
  assert.deepEqual(diagnostics(result.stderr), [{ event: "runtime_observer", coverage }]);
  assert.ok(!result.stderr.includes("private"));
});

test("runtime observer skips installation when imported in a worker thread", { timeout: 20_000 }, async t => {
  const context = await fixture(t);
  const thread = `const {parentPort}=require('node:worker_threads');
    const childProcess=require('node:child_process'), original=childProcess.spawn;
    import(${JSON.stringify(pathToFileURL(context.observer).href)}).then(()=>parentPort.postMessage(childProcess.spawn===original));`;
  const result = await execute(context, `
    import {Worker} from 'node:worker_threads';
    const worker=new Worker(${JSON.stringify(thread)},{eval:true});
    worker.once('message',value=>{if(value!==true)process.exitCode=1;});
  `);
  assert.deepEqual(diagnostics(result.stderr), [
    { event: "runtime_observer", coverage: "installed" }, { event: "runtime_observer", coverage: "worker_thread" },
  ]);
});
