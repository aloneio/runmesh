import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { handleMcpSecret } from "../src/http/mcp.js";
import { handleBrowserAdmin } from "../src/http/admin.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
async function fixture() {
  const session = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier('central-skills-test-password');
  await runInDurableObject(registry(), instance => { const now = Date.now(); instance.setupAdmin(verifier, now); expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true); });
  const headers = { cookie: ADMIN_SESSION_COOKIE + '=' + session + '; ' + ADMIN_CSRF_COOKIE + '=' + csrf, origin: 'https://worker.test', 'content-type': 'application/json', 'x-csrf-token': csrf };
  const clients = [];
  for (let n = 0; n < 2; n++) {
    const secret = randomBase64Url(), id = 'skill-client-' + crypto.randomUUID(), path = '/auth/clients';
    const body = JSON.stringify({ identity_version: 2, client_id: id, label: 'Skill only', native_scopes: [], secret_verifier: await sha256Hex(secret), secret_prefix: 'fixture' });
    expect((await registry().fetch(new Request('https://registry.internal' + path, { method: 'POST', body, headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, 'POST', path, body) }))).status).toBe(200);
    clients.push({ secret, id });
  }
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES, stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  const configured: WorkerEnv = { ...env, CENTRAL_SKILLS_ENABLED: '1', RUNMESH_PUBLIC_ORIGIN: 'https://worker.test' };
  let instance: CapabilitiesDOv1;
  await runInDurableObject(stub, (_old, state) => { instance = new CapabilitiesDOv1(state, configured); });
  const invoke = <T>(action: (owner: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => action(instance));
  const port = { getToolset: (h: string, id: string) => invoke(o => o.getToolset(h, id)), mutateToolset: (h: string, q: unknown) => invoke(o => o.mutateToolset(h, q)),
    mutateSkill: (h: string, q: unknown) => invoke(o => o.mutateSkill(h, q)), inspectSkill: (h: string, id: string, d?: string) => invoke(o => o.inspectSkill(h, id, d)),
    listSkills: (p: { client_id: string; secret_version: number }, q: unknown) => invoke(o => o.listSkills(p, q)), readSkill: (p: { client_id: string; secret_version: number }, q: unknown) => invoke(o => o.readSkill(p, q)),
    getClientGrant: (h: string, id: string) => invoke(o => o.getClientGrant(h, id)), setClientGrant: (h: string, q: unknown) => invoke(o => o.setClientGrant(h, q)) };
  const config = { ...configured, CAPABILITIES: { idFromName: () => 'central', get: () => port } } as unknown as WorkerEnv;
  const admin = async (path: string, body?: unknown, h = headers) => { const request = new Request('https://worker.test/admin/central/' + path, { method: body ? 'POST' : 'GET', headers: h, ...(body ? { body: JSON.stringify(body) } : {}) }); return handleCentralAdmin(request, config, new URL(request.url)); };
  const rpc = async (secret: string, method: string, params: unknown, override = config) => {
    const request = new Request('https://worker.test/' + secret + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }) });
    const response = await handleMcpSecret(request, override, new URL(request.url)); expect(response.status).toBe(200);
    const text = await response.text(), nl = String.fromCharCode(10);
    const messages = response.headers.get('content-type')?.includes('text/event-stream') ? text.split(nl).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))) : [JSON.parse(text)];
    return messages.find(m => m.id === 'test');
  };
  return { config, headers, clients, admin, rpc, invoke, hash };
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
  expect((await f.admin('toolsets/research-team', { action: 'replace', expected_revision: 0, enabled: true, rules: [{ kind: 'skill', resource_id: 'research', version: digest }] })).status).toBe(200);
  for (const client of f.clients) {
    expect((await f.admin('toolsets/research-team', { action: 'apply', expected_revision: 0, toolset_revision: 1, client_id: client.id })).status).toBe(200);
    const listed = await f.rpc(client.secret, 'tools/call', { name: 'skill_list', arguments: {} });
    expect(JSON.parse(listed.result.content[0].text)).toMatchObject({ state: 'listed', skills: [{ digest }] });
    const read = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: 'research', digest, path: 'references/proof.md' } });
    expect(JSON.parse(read.result.content[0].text)).toMatchObject({ state: 'read', text: 'pinned proof', dependencies: [{ state: 'not_authorized' }] });
    const resource = await f.rpc(client.secret, 'resources/read', { uri: 'runmesh-skill://bundle/research/' + digest + '/references/proof.md' });
    expect(resource.result.contents[0].text).toBe('pinned proof');
    expect(resource.result.contents[0]._meta['runmesh/dependencies']).toEqual(JSON.parse(read.result.content[0].text).dependencies);
    const shell = await f.rpc(client.secret, 'tools/call', { name: 'shell', arguments: { workspace_id: 'any', script: 'echo test' } });
    expect(shell.result?.isError ?? !!shell.error).toBe(true);
  }
  const client = f.clients[0]!;
  expect((await f.admin('toolsets/research-team', { action: 'replace', expected_revision: 1, enabled: false, rules: [] })).status).toBe(200);
  const existingGrant = await (await f.admin('grants/' + client.id)).json() as { grant: { rules: unknown[] } };
  expect(existingGrant.grant.rules).toHaveLength(1);
  expect((await f.admin('toolsets/research-team', { action: 'apply', expected_revision: 1, toolset_revision: 1, client_id: client.id })).status).toBe(404);
  expect((await f.admin('grants/' + client.id, { expected_revision: 1, enabled: false, rules: [] })).status).toBe(200);
  const denied = await f.rpc(client.secret, 'tools/call', { name: 'skill_read', arguments: { skill_id: 'research', digest } });
  expect(denied.result.isError).toBe(true);
  const request = new Request('https://worker.test/admin/central', { headers: f.headers });
  const page = await handleBrowserAdmin(request, f.config, new URL(request.url));
  expect(page.status).toBe(200); expect(await page.text()).toContain('data-central-admin');
});
it('W07/W08 admin mutations require CSRF and feature-off retains the ten native tools without central I/O', async () => {
  const f = await fixture();
  expect((await f.admin('grants/' + f.clients[0]!.id, { expected_revision: 0, enabled: true, rules: [] }, { ...f.headers, 'x-csrf-token': 'wrong' })).status).toBe(403);
  const off = { ...f.config, CENTRAL_SKILLS_ENABLED: '0', CAPABILITIES: { idFromName: () => { throw new Error('central I/O forbidden'); } } } as unknown as WorkerEnv;
  const result = await f.rpc(f.clients[0]!.secret, 'tools/list', {}, off);
  expect(result.result.tools).toHaveLength(10);
});
it('W08/W09 administration strips unexpected owner fields and rejects malformed receipts', async () => {
  const f = await fixture(), secret = 'OWNER_SECRET_MUST_NOT_ESCAPE';
  const receipt = { request_id: crypto.randomUUID(), client_id: 'client', profile_id: 'docs', tool_id: 'tool', version: 'a'.repeat(64),
    operation_state: 'completed', code: 'completed', created_at_ms: Date.now(), token: secret };
  const owner = { getToolset: async () => ({ state: 'found', toolset: { schema_version: 1, toolset_id: 'team', revision: 1, enabled: true, rules: [], token: secret }, token: secret }),
    getClientGrant: async () => ({ state: 'denied', token: secret }), listCentralReceipts: async () => ({ state: 'listed', receipts: [receipt], token: secret }) };
  const config = { ...f.config, CENTRAL_GOVERNANCE_ENABLED: '1', CAPABILITIES: { idFromName: () => 'central', get: () => owner } } as unknown as WorkerEnv;
  for (const path of ['toolsets/team', 'grants/client', 'receipts']) {
    const request = new Request('https://worker.test/admin/central/' + path, { headers: f.headers });
    const response = await handleCentralAdmin(request, config, new URL(request.url));
    expect(response.status).toBe(path.startsWith('grants') ? 403 : 200);
    expect(await response.text()).not.toContain(secret);
  }
  receipt.code = secret;
  const request = new Request('https://worker.test/admin/central/receipts', { headers: f.headers });
  const response = await handleCentralAdmin(request, config, new URL(request.url));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
});
