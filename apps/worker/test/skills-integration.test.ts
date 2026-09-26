import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { handleMcpSecret } from "../src/http/mcp.js";
import { handleBrowserAdmin } from "../src/http/admin.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
async function fixture(nativeScopes: ["coding:read"] | [] = []) {
  const session = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier('central-skills-test-password');
  await runInDurableObject(registry(), instance => { const now = Date.now(); instance.setupAdmin(verifier, now); expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true); });
  const headers = { cookie: ADMIN_SESSION_COOKIE + '=' + session + '; ' + ADMIN_CSRF_COOKIE + '=' + csrf, origin: 'https://worker.test', 'content-type': 'application/json', 'x-csrf-token': csrf };
  const clients = [];
  for (let n = 0; n < 2; n++) {
    const secret = randomBase64Url(), id = 'skill-client-' + crypto.randomUUID(), path = '/auth/clients';
    const body = JSON.stringify({ identity_version: 2, client_id: id, label: 'Skill fixture', native_scopes: nativeScopes, secret_verifier: await sha256Hex(secret), secret_prefix: 'fixture' });
    expect((await registry().fetch(new Request('https://registry.internal' + path, { method: 'POST', body, headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, 'POST', path, body) }))).status).toBe(200);
    clients.push({ secret, id });
  }
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES, stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  const configured: WorkerEnv = { ...env, CENTRAL_SKILLS_ENABLED: '1', RUNMESH_PUBLIC_ORIGIN: 'https://worker.test' };
  let instance: CapabilitiesDOv1;
  await runInDurableObject(stub, (_old, state) => { instance = new CapabilitiesDOv1(state, configured); });
  const invoke = <T>(action: (owner: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => action(instance));
  const port = { installSkill: (h: string, q: unknown) => invoke(o => o.installSkill(h, q)), listSkillLibrary: (h: string, after?: string) => invoke(o => o.listSkillLibrary(h, after)), toolVisibility: (p: { client_id: string; secret_version: number }) => invoke(o => o.toolVisibility(p)),
    mutateSkill: (h: string, q: unknown) => invoke(o => o.mutateSkill(h, q)), inspectSkill: (h: string, id: string, d?: string) => invoke(o => o.inspectSkill(h, id, d)),
    listSkills: (p: { client_id: string; secret_version: number }, q: unknown) => invoke(o => o.listSkills(p, q)), readSkill: (p: { client_id: string; secret_version: number }, q: unknown) => invoke(o => o.readSkill(p, q)) };
  const config = { ...configured, CAPABILITIES: { idFromName: () => 'central', get: () => port } } as unknown as WorkerEnv;
  const admin = async (path: string, body?: unknown, h = headers) => { const request = new Request('https://worker.test/admin/central/' + path, { method: body ? 'POST' : 'GET', headers: h, ...(body ? { body: JSON.stringify(body) } : {}) }); return handleCentralAdmin(request, config, new URL(request.url)); };
  const rpc = async (secret: string, method: string, params: unknown, override = config) => {
    const request = new Request('https://worker.test/' + secret + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }) });
    const response = await handleMcpSecret(request, override, new URL(request.url)); expect(response.status).toBe(200);
    const text = await response.text(), nl = String.fromCharCode(10);
    const messages = response.headers.get('content-type')?.includes('text/event-stream') ? text.split(nl).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))) : [JSON.parse(text)];
    return messages.find(m => m.id === 'test');
  };
  return { config, headers, clients, admin, rpc, invoke, hash, port, stub };
}
it('W07/W08 two independent central-only clients read the same approved bundle through tools and resources without a Runner', async () => {
  const f = await fixture();
  const files = [{ path: 'SKILL.md', text: ['---', 'name: research', 'description: Check central documentation', '---', 'Never auto-execute scripts.'].join(String.fromCharCode(10)) }, { path: 'references/proof.md', text: 'pinned proof' }];
  files.push({ path: 'runmesh.json', text: JSON.stringify({ schema_version: 1, requiredCapabilities: [{ kind: 'skill', resource_id: 'other', version: 'a'.repeat(64) }] }) });
  const stage = { action: 'preview', source: 'local', license: 'MIT', files };
  const preview = await (await f.admin('skills/research', stage)).json() as { bundle: { digest: string } }; const digest = preview.bundle.digest;
  expect((await f.admin('skills/research')).status).toBe(404);
  expect((await f.admin('skills/research', { ...stage, action: 'stage', expected_revision: 0 })).status).toBe(200);
  expect((await f.admin('skills/research', { action: 'activate', expected_revision: 1, digest })).status).toBe(200);
  await runInDurableObject(f.stub, (_owner, state) => {
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capability_grants_v1'").toArray()).toEqual([]);
  });
  for (const client of f.clients) {
      const tools = await f.rpc(client.secret, 'tools/list', {});
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['skill_list', 'skill_read']));
    expect(tools.result.tools).toHaveLength(5);
    const templates = await f.rpc(client.secret, 'resources/templates/list', {});
    expect(templates.result.resourceTemplates).toHaveLength(1);
    const listed = await f.rpc(client.secret, 'tools/call', { name: 'skill_list', arguments: {} });
    expect(JSON.parse(listed.result.content[0].text)).toMatchObject({ state: 'listed', skills: [{ digest }] });
    const read = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: 'research', digest, path: 'references/proof.md' } });
    expect(JSON.parse(read.result.content[0].text)).toMatchObject({ state: 'read', text: 'pinned proof', dependencies: [{ state: 'not_configured' }] });
    const resource = await f.rpc(client.secret, 'resources/read', { uri: 'runmesh-skill://bundle/research/' + digest + '/references/proof.md' });
    expect(resource.result.contents[0].text).toBe('pinned proof');
    expect(resource.result.contents[0]._meta['runmesh/dependencies']).toEqual(JSON.parse(read.result.content[0].text).dependencies);
    const shell = await f.rpc(client.secret, 'tools/call', { name: 'shell', arguments: { workspace_id: 'any', script: 'echo test' } });
    expect(shell.result?.isError ?? !!shell.error).toBe(true);
  }
  await runInDurableObject(registry(), owner => { owner.revokeMcpClient(f.clients[1]!.id, Date.now()); });
  expect(await f.invoke(owner => owner.listSkills({ client_id: f.clients[1]!.id, secret_version: 1 }, {}))).toEqual({ state: 'denied' });
  const client = f.clients[0]!;
  expect((await f.admin('skills/research', { action: 'disable', expected_revision: 2 })).status).toBe(200);
  expect((await f.rpc(client.secret, 'tools/list', {})).result.tools).toHaveLength(5);
  const denied = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: 'research', digest } });
  expect(denied.result.isError).toBe(true);
  const request = new Request('https://worker.test/admin/central', { headers: f.headers });
  const page = await handleBrowserAdmin(request, f.config, new URL(request.url));
  expect(page.status).toBe(200); expect(await page.text()).toContain('data-central-product');
});
it('Acceptance T05 publishes shared discovery without grants and denies unpublished content', async () => {
  const f = await fixture(['coding:read']), client = f.clients[0]!;
  const config = { ...f.config, CENTRAL_DIRECT_TOOLS_ENABLED: '1' };
  expect((await f.rpc(client.secret, 'tools/list', {}, config)).result.tools).toHaveLength(16);
  const templates = await f.rpc(client.secret, 'resources/templates/list', {}, config);
  expect(templates.result.resourceTemplates).toHaveLength(1);
  const denied = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: 'ungranted', digest: 'a'.repeat(64) } }, config);
  expect(denied.result.isError).toBe(true);
  expect(JSON.parse(denied.result.content[0].text).error.code).toBe('skill_denied');
  expect((await f.rpc(client.secret, 'tools/list', {}, config)).result.tools).toHaveLength(16);
  const granted = await f.rpc(client.secret, 'tools/list', {}, config);
  expect(granted.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['skill_list', 'skill_read']));
  expect(granted.result.tools).toHaveLength(16);
  expect(await f.invoke(o => o.toolVisibility({ client_id: client.id, secret_version: 2 }))).toEqual({ state: 'denied' });
});
it('central visibility failure or malformed metadata hides central discovery without touching native calls', async () => {
  const f = await fixture(['coding:read']), client = f.clients[0]!;
  f.port.toolVisibility = async () => { throw new Error('central unavailable'); };
  expect((await f.rpc(client.secret, 'tools/list', {})).result.tools).toHaveLength(10);
  f.port.toolVisibility = async () => JSON.parse('{"state":"visible","skill":"yes","remote":true}');
  expect((await f.rpc(client.secret, 'tools/list', {})).result.tools).toHaveLength(10);
  const get = vi.fn(() => { throw new Error('native calls must not resolve central storage'); });
  const config = { ...f.config, CAPABILITIES: { idFromName: get, get } } as unknown as WorkerEnv;
  const native = await f.rpc(client.secret, 'tools/call', { name: 'runner_list', arguments: {} }, config);
  expect(native.error).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
it('W07/W08 admin mutations require CSRF and feature-off retains the ten native tools without central I/O', async () => {
  const f = await fixture(['coding:read']);
  expect((await f.admin('skill-installations', { files: [] }, { ...f.headers, 'x-csrf-token': 'wrong' })).status).toBe(403);
  const off = { ...f.config, CENTRAL_SKILLS_ENABLED: '0', CAPABILITIES: { idFromName: () => { throw new Error('central I/O forbidden'); } } } as unknown as WorkerEnv;
  const result = await f.rpc(f.clients[0]!.secret, 'tools/list', {}, off);
  expect(result.result.tools).toHaveLength(10);
});
it('W08/W09 administration strips unexpected owner fields and rejects malformed receipts', async () => {
  const f = await fixture(), secret = 'OWNER_SECRET_MUST_NOT_ESCAPE';
  const receipt = { request_id: crypto.randomUUID(), client_id: 'client', profile_id: 'docs', tool_id: 'tool', version: 'a'.repeat(64),
    operation_state: 'completed', code: 'completed', created_at_ms: Date.now(), token: secret };
  const owner = { listCentralReceipts: async () => ({ state: 'listed', receipts: [receipt], token: secret }) };
  const config = { ...f.config, CENTRAL_GOVERNANCE_ENABLED: '1', CAPABILITIES: { idFromName: () => 'central', get: () => owner } } as unknown as WorkerEnv;
  for (const path of ['receipts']) {
    const request = new Request('https://worker.test/admin/central/' + path, { headers: f.headers });
    const response = await handleCentralAdmin(request, config, new URL(request.url));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
  }
  receipt.code = secret;
  const request = new Request('https://worker.test/admin/central/receipts', { headers: f.headers });
  const response = await handleCentralAdmin(request, config, new URL(request.url));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
});


it('product browser creates a central-only client with confirmed secret and no computer scopes', async () => {
  const f = await fixture(), data = new FormData();
  data.set('csrf_token', f.headers['x-csrf-token']); data.set('label', 'Central product client'); data.set('access_mode', 'central');
  // Stale native checkboxes must not add machine privileges in central-only mode.
  data.append('scopes', 'coding:exec');
  const headers = new Headers(f.headers); headers.delete('content-type');
  const request = new Request('https://worker.test/admin/clients', { method: 'POST', headers, body: data });
  const response = await handleBrowserAdmin(request, f.config, new URL(request.url));
  expect(response.status).toBe(200);
  const markup = await response.text();
  const secret = /https:\/\/worker\.test\/([A-Za-z0-9_-]+)\/mcp/u.exec(markup)?.[1];
  expect(secret !== undefined).toBe(true);
  const tools = await f.rpc(secret!, 'tools/list', {});
  expect(tools.result.tools.some((tool: { name: string }) => ['shell', 'edit', 'job'].includes(tool.name))).toBe(false);
  await runInDurableObject(registry(), instance => {
    const client = instance.listMcpClients().find(c => c.label === 'Central product client');
    expect(client?.scopes).toEqual([]); expect(client?.revoked_at_ms).toBeNull();
  });
});

it('product Skill library includes drafts, paginates exactly, and never includes file bodies', async () => {
  const f = await fixture();
  for (let n = 0; n < 51; n++) {
    const id = 'library-' + String(n).padStart(2, '0');
    const result = await f.invoke(o => o.mutateSkill(f.hash, { action: 'stage', skill_id: id, expected_revision: 0,
      source: 'local fixture', license: 'MIT', files: [{ path: 'SKILL.md', text: '---\nname: library\ndescription: Library fixture\n---\nPRIVATE FILE BODY' }] }));
    expect(result.state).toBe('written');
  }
  const response = await f.admin('skills'), text = await response.text(), first = JSON.parse(text);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(first.skills).toHaveLength(50); expect(first.next_after).toBe('library-49');
  expect(first.skills[0]).toMatchObject({ head: { enabled: false }, summary: { name: 'library' } });
  expect(text).not.toContain('PRIVATE FILE BODY'); expect(text).not.toContain('files');
  const second = await (await f.admin('skills?after=' + first.next_after)).json();
  expect(second).toMatchObject({ state: 'listed', next_after: null, skills: [{ head: { skill_id: 'library-50' } }] });
  expect((await f.admin('skills?digest=wrong')).status).toBe(400);
  expect((await f.admin('skills', undefined, { ...f.headers, cookie: '' })).status).toBe(403);
  expect(await f.invoke(o => o.listSkillLibrary('invalid-session'))).toEqual({ state: 'denied' });
});

it('shared Skills paginate beyond 128 including empty disabled pages through tools and resources', async () => {
  const f = await fixture();
  for (let n = 0; n < 130; n++) {
    const id = 'shared-' + String(n).padStart(3, '0');
    const result = await f.invoke(o => o.installSkill(f.hash, { expected_revision: 0,
      files: [{ path: 'SKILL.md', text: '---\nname: ' + id + '\ndescription: Shared pagination\n---\nContent' }] }));
    expect(result.state).toBe('written');
    if (n < 128) expect((await f.invoke(o => o.mutateSkill(f.hash, { action: 'disable', skill_id: id, expected_revision: 1 }))).state).toBe('written');
  }
  for (const client of f.clients) {
    const first = JSON.parse((await f.rpc(client.secret, 'tools/call', { name: 'skill_list', arguments: {} })).result.content[0].text);
    expect(first).toEqual({ state: 'listed', skills: [], next_after: 'shared-127' });
    const second = JSON.parse((await f.rpc(client.secret, 'tools/call', { name: 'skill_list', arguments: { after: first.next_after } })).result.content[0].text);
    expect(second.skills.map((s: { skill_id: string }) => s.skill_id)).toEqual(['shared-128', 'shared-129']);
    expect(second.next_after).toBeNull();
    const resources = await f.rpc(client.secret, 'resources/list', {});
    expect(resources.result.resources).toHaveLength(2);
  }
});

it('removed authorization routes follow ordinary not-found handling without resolving an owner', async () => {
  const f = await fixture(), get = vi.fn(() => { throw new Error('unknown routes must not resolve an owner'); });
  const config = { ...f.config, CAPABILITIES: { idFromName: get, get } } as unknown as WorkerEnv;
  for (const path of ['grants/client', 'toolsets/team', 'oauth/begin', 'oauth/complete', 'oauth/revoke', 'oauth/callback']) for (const method of ['GET', 'POST']) {
    const request = new Request('https://worker.test/admin/central/' + path, { method, headers: f.headers, ...(method === 'POST' ? { body: '{}' } : {}) });
    const response = await handleCentralAdmin(request, config, new URL(request.url));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'central_not_found' } });
  }
  expect(get).not.toHaveBeenCalled();
});

it('direct Skill installation derives metadata, installs atomically and updates all clients and rejects cached old digests', async () => {
  const f = await fixture(), client = f.clients[0]!;
  const files = [{ path: 'SKILL.md', text: ['---', 'name: direct-install', 'description: Installed from control panel', '---', 'First version'].join(String.fromCharCode(10)) }];
  const installed = await f.admin('skill-installations', { files }); expect(installed.status).toBe(200);
  const result = await installed.json() as { skill_id: string; digest: string }; expect(result.skill_id).toBe('direct-install');
  const item = await (await f.admin('skills/direct-install')).json() as { head: { enabled: boolean; revision: number }; bundle: { name: string } };
  expect(item.head).toMatchObject({ enabled: true, revision: 1 }); expect(item.bundle.name).toBe('direct-install');
  expect((await f.rpc(client.secret, 'tools/list', {})).result.tools).toHaveLength(5);
  files[0]!.text += ' updated';
  expect((await f.admin('skill-installations', { files })).status).toBe(409);
  expect((await f.admin('skill-installations', { files, expected_revision: 1 })).status).toBe(200);
  const read = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: result.skill_id, digest: result.digest } });
  expect(read.result.isError).toBe(true);
  for (const current of f.clients) {
    const list = JSON.parse((await f.rpc(current.secret, 'tools/call', { name: 'skill_list', arguments: {} })).result.content[0].text);
    expect(list.skills[0].digest).not.toBe(result.digest);
    const currentRead = await f.rpc(current.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: result.skill_id, digest: list.skills[0].digest } });
    expect(JSON.parse(currentRead.result.content[0].text).text).toContain('updated');
  }
  expect((await f.admin('skill-installations', { files }, { ...f.headers, 'x-csrf-token': 'invalid' })).status).toBe(403);
  expect((await f.admin('skill-installations', { files: [{ path: '../SKILL.md', text: files[0]!.text }] })).status).toBe(400);
});
