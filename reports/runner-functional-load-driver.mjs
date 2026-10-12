import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { RunnerRuntime } from '../apps/runner/src/runtime.ts';
import { JobManager } from '../apps/runner/src/jobs.ts';
import { GitService } from '../apps/runner/src/git-service.ts';
import { ContextStore } from '../apps/runner/src/context-store.ts';

const tempRoot = await realpath(tmpdir());
const base = await mkdtemp(join(tempRoot, 'runmesh-load-'));
const root = join(base, 'workspace'), state = join(base, 'state');
await mkdir(root); await mkdir(state, { mode: 0o700 });
const observations = {}, budgetObservations = [], started = performance.now();
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
const runtime = new RunnerRuntime({ config: { server: 'ws://127.0.0.1', token: 'local-load-fixture-only', runnerId: 'load-runner', stateDir: state,
  workspaces: [{ workspaceId: 'w', rootPath: await realpath(root), readonly: false, shell: false }], maxConcurrentJobs: 3 } });
const measure = async (kind, action) => { const begin = performance.now(); const value = await action(); (observations[kind] ??= []).push(performance.now() - begin); return value; };
const pool = async (items, concurrency, action) => { let index = 0; const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => { while (index < items.length) { const current = index++; await action(items[current], current); } })); const errors = workers.filter(value => value.status === 'rejected'); if (errors.length) throw new AggregateError(errors.map(value => value.reason), 'load phase failed'); };
const wait = async predicate => { const deadline = performance.now() + 120000; while (!predicate()) { assert(performance.now() < deadline, 'job convergence deadline'); await new Promise(resolve => setTimeout(resolve, 25)); } };
const input = (index, command) => ({ workspace_id: 'w', command: [process.execPath, '-e', command], request_id: `load-${index}`, created_by_client_id: `client-${index % 3}` });
const line = 'Runmesh 中文🙂 payload\n', output = line.repeat(256);
const emit = `process.stdout.write(${JSON.stringify(output)});process.stderr.write('diagnostic\\n');`;
const jobs = [];
let failure;
try {
  await runtime.jobs.initialize();
  runtime.jobs.setQueueAuthorizer(async () => true);
  for (let i = 0; i < 3; i++) jobs.push(await measure('job_start', () => runtime.dispatch('exec.start', input(i, `process.stdin.resume();process.stdin.on('end',()=>{${emit}});`))));
  await pool(Array.from({ length: 15 }, (_, i) => i + 3), 4, async i => jobs.push(await measure('job_start', () => runtime.dispatch('exec.start', input(i, emit)))));
  assert.equal(runtime.jobs.queueStatus().waiting, 15);
  assert.equal(runtime.jobs.queueStatus().running, 3);
  for (const job of jobs.slice(0, 3)) await measure('job_input', () => runtime.dispatch('job.input', { job_id: job.job_id, expected_workspace_id: 'w', close_stdin: true }));
  let peakRunning = 3;
  await wait(() => { peakRunning = Math.max(peakRunning, runtime.jobs.queueStatus().running); return jobs.every(job => runtime.jobs.get(job.job_id).status === 'succeeded'); });
  assert.equal(peakRunning, 3); await runtime.jobs.flushPersistence();
  await pool(jobs, 3, async job => {
    let cursor, text = '', pages = 0;
    do {
      const page = await measure('job_log_page', () => runtime.dispatch('job.logs', { job_id: job.job_id, expected_workspace_id: 'w', stream: 'stdout', limit: 509, ...(cursor === undefined ? { consistency: 'append' } : { cursor }) }));
      text += page.data; cursor = page.next_cursor; assert(++pages < 100);
    } while (cursor !== null);
    assert.equal(text, output);
  });
  const restored = new JobManager({ policy: runtime.policy, stateDir: state, maxConcurrentJobs: 3 });
  await measure('job_recovery', () => restored.initialize());
  assert.equal(restored.list().filter(job => job.status === 'succeeded').length, 18);
  const ids = Array.from({ length: 24 }, (_, i) => i);
  await pool(ids, 4, async i => measure('patch_create', () => runtime.dispatch('fs.apply_patch', { workspace_id: 'w', patch: `*** Begin Patch\n*** Add File: file-${i}.txt\n+${line.trim()} ${i}\n*** End Patch\n` })));
  await pool(ids, 4, async i => measure('patch_update', () => runtime.dispatch('fs.apply_patch', { workspace_id: 'w', patch: `*** Begin Patch\n*** Update File: file-${i}.txt\n@@\n-${line.trim()} ${i}\n+${line.trim()} updated-${i}\n*** End Patch\n` })));
  await pool(Array.from({ length: 192 }, (_, i) => i % 24), 4, async i => {
    const page = await measure('file_read', () => runtime.dispatch('fs.read', { workspace_id: 'w', path: `file-${i}.txt`, limit: 256 }));
    assert.equal(page.data, `${line.trim()} updated-${i}\n`);
  });
  const large = line.repeat(128);
  await runtime.dispatch('fs.apply_patch', { workspace_id: 'w', patch: `*** Begin Patch\n*** Add File: pages.txt\n${large.trimEnd().split('\n').map(value => `+${value}`).join('\n')}\n*** End Patch\n` });
  let cursor, text = '';
  do {
    const page = await measure('file_snapshot_page', () => runtime.dispatch('fs.read', { workspace_id: 'w', path: 'pages.txt', limit: 113, ...(cursor === undefined ? { consistency: 'snapshot' } : { cursor }) }));
    text += page.data; cursor = page.next_cursor;
  } while (cursor !== null);
  assert.equal(text, large);
  for (let i = 0; i < 4; i++) {
    const search = await measure('file_search', () => runtime.dispatch('fs.search', { workspace_id: 'w', path: '.', query: 'updated-', limit: 100 }));
    assert.equal(new Set(search.results.map(value => value.path)).size, search.results.length);
    assert(search.results.every(value => /^file-\d+\.txt$/.test(value.path)));
    if (search.results.length !== 24) { assert.equal(search.truncated, true); assert.equal(search.truncated_reason, 'time_budget'); }
    budgetObservations.push({ operation: 'file_search', returned: search.results.length, truncated: search.truncated, reason: search.truncated_reason });
  }
  await mkdir(join(root, 'focused'));
  await runtime.dispatch('fs.apply_patch', { workspace_id: 'w', patch: '*** Begin Patch\n*** Add File: focused/match.txt\n+updated-focused\n*** End Patch\n' });
  const focused = await measure('file_search_scoped', () => runtime.dispatch('fs.search', { workspace_id: 'w', path: 'focused', query: 'updated-' }));
  assert.equal(focused.results.length, 1); assert.equal(focused.truncated, false);
  const gitExecutable = process.env.RUNMESH_LOAD_GIT;
  assert(gitExecutable, 'explicit local Git executable');
  const command = promisify(execFile);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Runmesh Load', '-c', 'user.email=load@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'local fixture']]) await command(gitExecutable, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: root, windowsHide: true });
  const git = new GitService(runtime.policy, { executable: gitExecutable });
  const { commit: revision } = await git.head({ workspace_id: 'w' });
  await pool(Array.from({ length: 15 }, (_, i) => ['status', 'diff', 'log', 'show', 'blame'][i % 5]), 2, async kind => {
    const result = await measure(`git_${kind}`, () => git[kind]({ workspace_id: 'w', ...(kind === 'blame' ? { path: 'file-0.txt' } : {}), ...(kind === 'show' ? { revision, path: 'file-0.txt' } : {}) }));
    assert(result && typeof result === 'object');
  });
  const contexts = [];
  await pool(Array.from({ length: 12 }, (_, i) => i), 4, async i => {
    const result = await measure('context_checkpoint', () => runtime.context.checkpoint({ workspace_id: 'w', turn_id: `load-turn-${i}`, goal: `load context ${i}`, evidence: [{ kind: 'job', status: 'observed', job_id: jobs[i].job_id, exit_code: 0 }] }));
    contexts.push(result.context);
  });
  const recoveredContext = new ContextStore({ stateDir: state });
  await pool(contexts, 4, async context => {
    const value = await measure('context_recovery_read', () => recoveredContext.read({ workspace_id: 'w', context_id: context.context_id, revision: context.revision }));
    assert.equal(value.context.goal, context.goal);
  });
  const found = await measure('context_search', () => recoveredContext.search({ workspace_id: 'w', query: 'load context', limit: 50 }));
  assert.equal(found.results.length, 12);
  for (let i = 0; i < 4; i++) {
    const job = await runtime.dispatch('exec.start', input(100 + i, 'process.stdin.resume()'));
    const cancelled = await measure('job_cancel', () => runtime.dispatch('job.cancel', { expected_workspace_id: 'w', job_id: job.job_id }));
    assert.equal(cancelled.status, 'cancelled');
  }
} catch (error) { failure = String(error?.stack ?? error); }
finally {
  clearInterval(sampler);
  for (const job of runtime.jobs.list()) if (['running', 'queued', 'cancelling'].includes(job.status)) await runtime.jobs.cancel(job.job_id).catch(() => undefined);
  await runtime.jobs.flushPersistence();
  assert.equal(dirname(resolve(base)), resolve(tempRoot));
  await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
const metrics = Object.fromEntries(Object.entries(observations).map(([kind, durations]) => { durations.sort((a, b) => a - b); return [kind, { count: durations.length, p50_ms: +durations[Math.floor(durations.length * 0.5)].toFixed(2), p95_ms: +durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))].toFixed(2), max_ms: +durations.at(-1).toFixed(2) }]; }));
const report = { scope: 'isolated local Runner APIs with native Node/Git/filesystem; no network or system services', platform: process.platform, node: process.version,
  started_at_utc: new Date(Date.now() - (performance.now() - started)).toISOString(), elapsed_ms: Math.round(performance.now() - started), max_concurrent_jobs: 3, queued_peak: 15,
  parent_peak_rss_bytes: peakRss, rss_scope: 'load driver only; child process memory excluded', metrics, budget_observations: budgetObservations, success: failure === undefined, ...(failure === undefined ? {} : { failure }) };
await writeFile(new URL('../reports/runner-functional-load-2026-10-12.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (failure !== undefined) process.exitCode = 1;
