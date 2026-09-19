import { safeContextResult } from "../src/mcp/server.js";
import { ExternalAuditHistory } from "../src/external-audit.js";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runnerPolicyChecksum, RPC_OPERATION_METHODS, RPC_OPERATION_CONTRACT, bytePageMetadata } from "@aloneio/runmesh-protocol";
import { randomBase64Url, sha256Hex, internalHeaders } from "../src/security.js";

const full = { read: true, edit: true, shell: true, job_control: true };

it.each(["0.1.1", "0.1.2-dev.0", "0.1.4-dev.0", "0.1.4-dev.12", "0.2.0-dev.0", "1.0.0-dev.0"])("development release %s preserves history-independent Job compatibility, not permission grants", async version => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_instance, state) => { state.storage.sql.exec("UPDATE runners SET current_runner_version=? WHERE runner_id='r'", version); });
  const result = (await f.call("job", { action: "get", job_id: "j", workspace_id: "w" })).body.result;
  expect(result.isError).not.toBe(true); expect(f.forwarded).toHaveLength(1);
  expect((await f.call("job", { action: "cancel", job_id: "j", workspace_id: "forbidden" })).body.result.isError).toBe(true);
  expect(f.forwarded).toHaveLength(1);
});

it.each(["0.1.0", "0.1.0-dev.5", "0.1.1-dev.0", "0.1.4-beta.0", "0.1.4-dev.01", "0.1.4-dev.0\n", "unknown"])("unsupported version %s cannot bypass the existing Job floor", async version => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_instance, state) => { state.storage.sql.exec("UPDATE runners SET current_runner_version=? WHERE runner_id='r'", version); });
  const result = (await f.call("job", { action: "get", job_id: "j", workspace_id: "w" })).body.result;
  expect(result.structuredContent.error.code).toBe("runner_upgrade_required"); expect(f.forwarded).toHaveLength(0);
});

const contextUsage = { workspace_id: "w", storage_schema: 1, state: "ready", record_files: 4, record_bytes: 3000, context_count: 1, metadata_bytes: 800,
  limit_bytes: 33554432, limit_records: 4096, limit_contexts: 256, over_limit: false, pending_checkpoint: false, accounting: "logical_revision_bytes" };
const contextPreview = { workspace_id: "w", retention_schema: 1, applied: false, complete: true, plan_hash: "a".repeat(64), keep_days: 30, keep_revisions: 2,
  max_delete: 128, candidate_records: 2, candidate_bytes: 1000, eligible_records: 2, preserved_contexts: 1, has_more: false, scanned_files: 3, scanned_bytes: 1800, deleted_records: 0, deleted_bytes: 0 };

it("R08 authenticated storage inventory uses one RPC and strips local paths while preserving ordinary metadata audit", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { ...contextUsage, path: "/private-state", token: "private-token" } }));
  const result = (await f.call("context", { action: "storage", workspace_id: "w" })).body.result;
  expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject(contextUsage);
  expect(f.forwarded.map(call => call.method)).toEqual(["context.storage"]);
  expect(JSON.stringify(result)).not.toContain("private");
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(1);
  });
});

it("R08 read-only scope permits inventory but cannot preview or apply retention", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: contextUsage }));
  await runInDurableObject(f.stub, (_instance, state) => { state.storage.sql.exec("UPDATE mcp_clients SET scopes_json=? WHERE client_id='c'", JSON.stringify(["coding:read"])); });
  expect((await f.call("context", { action: "storage", workspace_id: "w" })).body.result.isError).not.toBe(true);
  for (const extra of [{}, { apply: true, expected_plan_hash: "a".repeat(64) }]) {
    const result = (await f.call("context", { action: "prune", workspace_id: "w", keep_days: 30, keep_revisions: 2, ...extra })).body.result;
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
  }
  expect(f.forwarded).toHaveLength(1);
});

it("R08 preview does not turn into apply and validated apply returns only bounded receipt data", async () => {
  const f = await fixture(request => Response.json({ type: "rpc.response", result: { ...contextPreview,
    ...(request.params.apply === true ? { applied: true, deleted_records: 2, deleted_bytes: 1000 } : {}), secret: "private-value" } }));
  const input = { action: "prune", workspace_id: "w", keep_days: 30, keep_revisions: 2 };
  const preview = (await f.call("context", input)).body.result;
  expect(preview.structuredContent).toMatchObject(contextPreview);
  expect(f.forwarded[0]?.params.apply).toBeUndefined();
  const result = (await f.call("context", { ...input, apply: true, expected_plan_hash: preview.structuredContent.plan_hash })).body.result;
  expect(result.structuredContent).toMatchObject({ applied: true, deleted_records: 2 });
  expect(JSON.stringify(result)).not.toContain("private-value");
  expect(f.forwarded.map(call => call.method)).toEqual(["context.prune", "context.prune"]);
});

it.each([{ apply: true }, { apply: "true" }, { expected_plan_hash: "a".repeat(64) }, { max_delete: 129 }, { keep_revisions: 0 }])("R08 invalid prune confirmation/bounds %j never reach the Runner", async extra => {
  const f = await fixture();
  const result = (await f.call("context", { action: "prune", workspace_id: "w", keep_days: 30, keep_revisions: 2, ...extra })).body.result;
  expect(result.isError).toBe(true); expect(f.forwarded).toHaveLength(0);
});

it("R08 contradictory successful retention output is not accepted as a cleanup receipt", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { ...contextPreview, applied: true } }));
  const result = (await f.call("context", { action: "prune", workspace_id: "w", keep_days: 30, keep_revisions: 2, apply: true, expected_plan_hash: contextPreview.plan_hash })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "context_result_invalid", operation_state: "unknown" } } });
});

it.each(["context_storage_full", "context_plan_changed", "context_scan_budget", "context_prune_partial"])("R08 %s survives the bridge without private details or automatic replay", async code => {
  const f = await fixture(() => Response.json({ type: "rpc.error", error: { code, message: "private-state-path", operation_state: code === "context_prune_partial" ? "unknown" : "not_started" } }, { status: 400 }));
  const result = (await f.call("context", { action: "prune", workspace_id: "w", keep_days: 30, keep_revisions: 2 })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code } } });
  expect(JSON.stringify(result)).not.toContain("private-state-path"); expect(f.forwarded).toHaveLength(1);
  if (code === "context_prune_partial") expect(result.structuredContent.error.operation_state).toBe("unknown");
});

it("R08 workspace selection cannot use an inventory or retention call to reach another workspace", async () => {
  const f = await fixture();
  for (const args of [{ action: "storage" }, { action: "prune", keep_days: 30, keep_revisions: 2 }]) expect((await f.call("context", { ...args, workspace_id: "forbidden" })).body.result.isError).toBe(true);
  expect(f.forwarded).toHaveLength(0);
});

it.each(["read", "job"])("R07 explicit bound %s reads reject legacy fallback without additional history writes", async tool => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { workspace_id:"w",path:"a",job_id:"j",stream:"stdout",data:"old",offset:0,size:3,...bytePageMetadata("old",0,3,3) } }));
  const args = tool === "read" ? {workspace_id:"w",path:"a",consistency:"snapshot"} : {action:"logs",workspace_id:"w",job_id:"j",consistency:"append"};
  const result = (await f.call(tool,args)).body.result;
  expect(result).toMatchObject({isError:true,structuredContent:{error:{code:"runner_upgrade_required",operation_state:"not_started"}}});
  expect(result.structuredContent.data).toBeUndefined();expect(f.forwarded).toHaveLength(1);
  await runInDurableObject(f.stub,(_instance,state)=>{
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    // Existing file-read audit remains one metadata row; Job no-record remains zero.
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(tool === "read" ? 1 : 0);
  });
});

it.each(["read", "job"])("R07 valid bound %s results survive the MCP envelope without an extra RPC", async tool => {
  const id="a".repeat(64),cursor=`${tool==="read"?"f1":"l1"}:${id}:2`;
  const raw={workspace_id:"w",path:"a",job_id:"j",stream:"stdout",encoding:"utf-8",data:"ok",offset:0,size:4,
    ...bytePageMetadata("ok",0,2,4),page_protocol:2,consistency:tool==="read"?"snapshot":"append",snapshot_id:id,next_cursor:cursor,resume_cursor:cursor,cursor_expires_at_ms:1000,secret:"private-secret"};
  const f=await fixture(()=>Response.json({type:"rpc.response",result:raw}));
  const args=tool==="read"?{workspace_id:"w",path:"a",consistency:"snapshot"}:{action:"logs",workspace_id:"w",job_id:"j",consistency:"append"};
  const result=(await f.call(tool,args)).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({page_protocol:2,snapshot_id:id,next_cursor:cursor,resume_cursor:cursor,audit_status:tool==="read"?"recorded":"disabled"});
  expect(JSON.stringify(result)).not.toContain("private-secret");expect(f.forwarded).toHaveLength(1);
});

it("R07 invalid bound peer evidence is rejected, not silently stripped into a live page", async () => {
  const cursor=`f1:${"a".repeat(64)}:2`;
  const f=await fixture(()=>Response.json({type:"rpc.response",result:{workspace_id:"w",path:"a",data:"ok",offset:0,size:4,
    ...bytePageMetadata("ok",0,2,4),page_protocol:2,consistency:"snapshot",snapshot_id:"b".repeat(64),next_cursor:cursor,resume_cursor:`f1:${"a".repeat(64)}:3`,cursor_expires_at_ms:1000}}));
  expect((await f.call("read",{workspace_id:"w",path:"a",consistency:"snapshot"})).body.result).toMatchObject({isError:true,structuredContent:{error:{code:"cursor_mismatch"}}});
});

it.each(["cursor_expired", "cursor_mismatch", "snapshot_too_large"])("R07 preserves %s safely across the authenticated bridge", async code => {
  const f=await fixture(()=>Response.json({type:"rpc.error",error:{code,message:"/private/path",operation_state:"not_started"}},{status:400}));
  const result=(await f.call("read",{workspace_id:"w",path:"a",consistency:"snapshot"})).body.result;
  expect(result).toMatchObject({isError:true,structuredContent:{error:{code,operation_state:"not_started"}}});
  expect(JSON.stringify(result)).not.toContain("private/path");
});

it.each(["log_unavailable", "log_changed", "file_changed", "read_budget_exhausted"])("R07 preserves %s across MCP without leaking paths or creating history writes", async code => {
  const f = await fixture(() => Response.json({ type: "rpc.error", error: { code, message: "private /home/private/secret", operation_state: "not_started", details: { token: "private-token" } } }, { status: 400 }));
  const result = (await f.call("job", { action: "logs", job_id: "j", workspace_id: "w" })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code, operation_state: "not_started" } } });
  expect(result.structuredContent.error.code).not.toBe("permission_denied");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(f.forwarded).toHaveLength(1);
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(0);
  });
});

it("R07 serves typed byte pages through the real MCP envelope with cloud history disabled", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { job_id: "j", stream: "stdout", data: "", offset: 2, size: 4, ...bytePageMetadata("", 2, 2, 4) } }));
  const result = (await f.call("job", { action: "logs", job_id: "j", workspace_id: "w" })).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ page_protocol: 1, page_state: "incomplete", resume_offset: 2, pending_bytes: 2, next_cursor: null, audit_status: "disabled" });
});

it("R07 inline log unavailability does not convert command exit 7 into a tool failure or empty output", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { completed: true, job: { job_id: "j", workspace_id: "w", status: "failed", exit_code: 7 }, stdout: { job_id: "j", stream: "stdout", available: false, error: { code: "log_unavailable", message: "/private/log" } } } }));
  const result = (await f.call("shell", { workspace_id: "w", command: "synthetic" })).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ status: "failed", exit_code: 7, completed: true, stdout: { available: false, error: { code: "log_unavailable" } } });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("R01 diagnoses implementation capabilities with one existing RPC and no Job or audit history writes", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: {
    hostname: "private-machine", workspaces: [{root_path:"/private/workspace"}], tools: { token: "private-token" },
    shell: {available:true,kind:"bash",version:"do-not-publish"},
    runtime_capabilities: { schema_version: 1, runner_version: "0.1.3", operation_contract_sha256: RPC_OPERATION_CONTRACT.sha256,
      supported_rpc_methods: [...RPC_OPERATION_METHODS], features: {job_queue:1,job_history:1,context_record:2}, max_concurrent_jobs:2 },
    job_scheduler: { waiting: 3, limit: 32, per_client_limit: 8, running: 2, max_concurrent_jobs: 2, available_slots: 0 },
  } }));
  const result = (await f.call("inspect", {action:"diagnostics",workspace_id:"w"})).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.capabilities).toMatchObject({report_state:"reported",contract_match:true,host_catalog_state:"not_observed",runner:{runner_version:"0.1.3",max_concurrent_jobs:2},worker_catalog:{tool_count:10,action_count:26}});
  expect(result.structuredContent.job_scheduler).toEqual({ waiting: 3, limit: 32, per_client_limit: 8, running: 2, max_concurrent_jobs: 2, available_slots: 0 });
  expect(f.forwarded.map(call => call.method)).toEqual(["env.info"]);
  for (const secret of ["private-machine", "/private/workspace", "private-token", "do-not-publish"]) expect(JSON.stringify(result)).not.toContain(secret);
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(0);
  });
});

it("R01 keeps an old Runner reachable while reporting its missing capabilities as unknown", async () => {
  const f = await fixture(() => Response.json({type:"rpc.response",result:{shell:{available:true,kind:"bash"}}}));
  const result = (await f.call("inspect",{action:"diagnostics",workspace_id:"w"})).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.capabilities).toMatchObject({report_state:"not_reported",runner:null,contract_match:null});
  expect(result.structuredContent.checks.find((check: any) => check.name === "runner_rpc").state).toBe("pass");
  expect(result.structuredContent.capabilities.actions.every((action: any) => action.runner_support === "unknown")).toBe(true);
});

it("R01 malformed capability reports do not leak peer fields or fabricate a complete inventory", async () => {
  const f = await fixture(() => Response.json({type:"rpc.response",result:{runtime_capabilities:{schema_version:1,runner_version:"999.1.0",secret:"private-secret"}}}));
  const result = (await f.call("inspect",{action:"diagnostics",workspace_id:"w"})).body.result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.capabilities).toMatchObject({report_state:"invalid",runner:null});
  expect(JSON.stringify(result)).not.toContain("private-secret");
});
async function fixture(responder?: (request: Record<string, any>) => Response | Promise<Response>) {
  const id = env.REGISTRY.idFromName(`no-record-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const secret = randomBase64Url(), verifier = await sha256Hex(secret);
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
    instance.createMcpClient({ client_id: "c", label: "test", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now);
    const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: full, workspaces: [{ workspace_id: "w", root_path: "/synthetic-workspace", enabled: true, permissions: full }] };
    const checksum = runnerPolicyChecksum(raw);
    state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=?, checksum=?, status='applied' WHERE runner_id='r' AND revision=1", JSON.stringify({ ...raw, checksum }), checksum);
    state.storage.sql.exec("UPDATE runners SET state='online', current_runner_version='0.1.1', connection_epoch=1, session_id='test-record-session', last_heartbeat_ms=?, runner_permissions_json=?, desired_policy_revision=1, applied_policy_revision=1, runner_reported_policy_revision=1, desired_policy_checksum=?, active_policy_checksum=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id='r'", now, JSON.stringify(full), checksum, checksum, checksum);
    expect(instance.selectMcpClientRunner("c", "r", false, now).ok).toBe(true);
    expect(instance.setJobRecording("c", false, now)?.record_jobs).toBe(false);
  });
  const forwarded: Record<string, any>[] = [];
  const job = { job_id: "j", workspace_id: "w", created_by_client_id: "c", status: "running", created_at_ms: Date.now(), updated_at_ms: Date.now() };
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub }, RUNNER: { idFromName: () => id, get: () => ({ fetch: async (req: Request) => {
    const input = await req.json() as Record<string, any>; forwarded.push(input);
    if (responder !== undefined) return responder(input);
    // job.input returns a byte acknowledgement, not a JobRecord. The former
    // mock concealed an empty projected success without testing stdin data.
    const result = input.method === "job.list" ? { jobs: [job] } : input.method === "job.input" ? { accepted: new TextEncoder().encode(String(input.params.data ?? "")).byteLength, eof: input.params.eof === true } : input.method === "exec.run" ? { job, completed: false } : job;
    return Response.json({ type: "rpc.response", result });
  } }) } } as unknown as typeof env;
  async function call(name: string, args: Record<string, unknown>) {
    const response = await worker.fetch(new Request(`https://record.test/${secret}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), localEnv, {} as ExecutionContext);
    const text = await response.text(), data = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    return { status: response.status, body: response.status === 200 ? JSON.parse(data ?? text) : undefined };
  }
  return { stub, call, forwarded, job, localEnv };
}

it("unrecorded Job operations and live listing do not require any cloud Job row", async () => {
  const f = await fixture();
  for (const action of ["get", "cancel", "input"]) {
    const result = await f.call("job", { action, job_id: "j", workspace_id: "w", ...(action === "input" ? { data: "test" } : {}) });
    expect(result.body.result.isError, JSON.stringify(result.body)).not.toBe(true);
    expect(result.body.result.structuredContent.audit_status).toBe("disabled");
    expect(f.forwarded.at(-1)?.params.expected_workspace_id).toBe("w");
    expect(f.forwarded.at(-1)?.mcp_authorization.workspace_bound).toBe(true);
    if (action === "input") expect(result.body.result.structuredContent).toMatchObject({ accepted: 4, eof: false });
  }
  const list = await f.call("job", { action: "list", workspace_id: "w" });
  expect(list.body.result.structuredContent).toMatchObject({ source: "runner_live", jobs: [{ job_id: "j", workspace_id: "w" }] });
  const shell = await f.call("shell", { workspace_id: "w", command: "synthetic" });
  expect(shell.body.result.structuredContent.audit_status).toBe("disabled");
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(0);
  });
});

it("AR05 an invalid stdin acknowledgement cannot become a successful empty object", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { job_id: "j", workspace_id: "w", status: "running", token: "private-fixture" } }));
  const result = (await f.call("job", { action: "input", job_id: "j", workspace_id: "w", data: "test" })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "tool_result_invalid", operation_state: "unknown" } } });
  expect(result.structuredContent.error.retry_after_ms).toBeUndefined();
  expect(result.structuredContent.error.recovery_hint).toContain("Do not repeat");
  expect(JSON.stringify(result)).not.toContain("private-fixture");
  expect(f.forwarded).toHaveLength(1);
  await runInDurableObject(f.stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(0);
  });
});

it("AR05 an incomplete execution result retains a safe Job identifier without replay", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { job: { job_id: "j", workspace_id: "w", root_path: "/private-fixture" }, completed: false } }));
  const result = (await f.call("shell", { workspace_id: "w", command: "synthetic" })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "tool_result_invalid", operation_state: "unknown", details: { job_id: "j", workspace_id: "w", audit_status: "disabled" } } } });
  expect(JSON.stringify(result)).not.toContain("private-fixture");
  expect(f.forwarded).toHaveLength(1);
});

it("recording preference cannot grant access to another workspace or an old Runner", async () => {
  const f = await fixture();
  expect((await f.call("job", { action: "cancel", job_id: "j", workspace_id: "forbidden" })).body.result.isError).toBe(true);
  expect(f.forwarded).toHaveLength(0);
  await runInDurableObject(f.stub, (_instance, state) => { state.storage.sql.exec("UPDATE runners SET current_runner_version='0.1.0' WHERE runner_id='r'"); });
  const old = await f.call("job", { action: "cancel", job_id: "j", workspace_id: "w" });
  expect(old.body.result.structuredContent.error.code).toBe("runner_upgrade_required");
  expect(f.forwarded).toHaveLength(0);
});

it("sync skips new unrecorded jobs and enabling later never backfills them", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance, state) => {
    const now = Date.now(), life = String(state.storage.sql.exec("SELECT lifecycle_id FROM runners WHERE runner_id='r'").one().lifecycle_id);
    const job = { ...f.job, created_at_ms: now + 1, updated_at_ms: now + 1 };
    const sync = (jobs: any[], sequence: number) => instance.syncRunner("r", 1, 1, [], jobs, sequence, now + 500, true, life, "test-record-session");
    expect(sync([job], 1)).toBe(true);
    expect(instance.getJob("r", "j")).toBeUndefined();
    expect(instance.setJobRecording("c", true, now + 100)?.record_jobs).toBe(true);
    expect(sync([job], 2)).toBe(true);
    expect(instance.getJob("r", "j")).toBeUndefined();
    expect(sync([{ ...job, job_id: "new", created_at_ms: now + 200, updated_at_ms: now + 200 }], 3)).toBe(true);
    expect(instance.getJob("r", "new")).toMatchObject({ job_id: "new" });
    instance.setJobRecording("c", false, now + 300);
    expect(instance.getJob("r", "new")).toBeDefined();
  });
});

it("recording setting requires authenticated internal requests and strict booleans", async () => {
  const f = await fixture(), path = "/auth/clients/c/recording";
  const request = async (value: unknown, signed: boolean) => {
    const body = JSON.stringify({ record_jobs: value });
    const headers = signed ? await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body) : {};
    return f.stub.fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body }));
  };
  expect((await request(true, false)).status).toBe(404);
  expect((await request("true", true)).status).toBe(400);
  const enabled = await request(true, true);
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ record_jobs: true });
});


it("a skipped optional Job write does not accidentally close its circuit breaker", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance, state) => {
    const now = Date.now(), life = String(state.storage.sql.exec("SELECT lifecycle_id FROM runners WHERE runner_id='r'").one().lifecycle_id);
    instance.setJobRecording("c", true, now);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let attempts = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith("INSERT INTO jobs")) { attempts++; throw new Error("synthetic history unavailable"); }
      return original(query, ...args);
    });
    try {
      for (let i=0;i<20;i++) expect(instance.syncRunner("r",1,1,[],[{...f.job,created_at_ms:now+1}],i+1,now+100,true,life,"test-record-session")).toBe(true);
      expect(attempts).toBe(1);
      expect(instance.featureHealthSnapshot(now+100).some((x) => x.feature === "job_recording")).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

it("saving an already enabled recording preference does not move the capture window", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance) => {
    const now = Date.now();
    instance.setJobRecording("c",true,now);
    expect(instance.setJobRecording("c",true,now+500)?.record_jobs_since_ms).toBe(now);
  });
});


it.each([false, true])("the production D1 audit path isolates history writes and failure=%s never undoes execution", async (outage) => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance, state) => {
    instance.setJobRecording("c", true, Date.now());
    const db = outage ? { prepare: () => { throw new Error("daily rows_read limit exceeded"); } } as unknown as D1Database : (env as unknown as { HISTORY_DB: D1Database }).HISTORY_DB;
    (instance as any).env = { ...(instance as any).env, RUNMESH_AUDIT_BACKEND: "d1", HISTORY_DB: db };
    (instance as any).externalAudit = new ExternalAuditHistory(db, state.id.toString());
  });
  const result = await f.call("shell", { workspace_id: "w", command: "synthetic" });
  expect(result.body.result.isError, JSON.stringify(result.body)).not.toBe(true);
  expect(result.body.result.structuredContent.audit_status).toBe(outage ? "degraded" : "recorded");
  expect(f.forwarded).toHaveLength(1);
  await runInDurableObject(f.stub, async (instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM mcp_calls").one().n).toBe(0);
    expect(instance.getMcpClient("c")).toBeDefined();
    if (outage) expect(instance.featureHealthSnapshot().some((x) => x.feature === "mcp_audit")).toBe(true);
    else {
      const life = String(state.storage.sql.exec("SELECT lifecycle_id FROM runners WHERE runner_id='r'").one().lifecycle_id);
      const rows = await (instance as any).externalAudit.list("r", life);
      expect(rows).toHaveLength(1);
      expect(rows[0].method).toBe("exec.run");
    }
  });
});


it.each([
  ["queue_full", "resource", "not_started", "wait_and_retry"],
  ["request_id_conflict", "conflict", "not_started", "re_read_and_retry"],
  ["search_snapshot_changed", "conflict", "not_started", "re_read_and_retry"],
  ["timeout", "availability", "unknown", "inspect_job"],
  ["context_index_stale", "conflict", "unknown", "inspect_job"],
])("R02 preserves %s semantics through the actual MCP error envelope", async (code, classification, state, action) => {
  const f=await fixture(() => Response.json({type:"rpc.error",error:{code,message:"DO_NOT_EXPOSE /private/path secret",operation_state:state}}, {status:400}));
  const result=await f.call("shell",{workspace_id:"w",command:"synthetic"});
  expect(result.body.result.isError).toBe(true);
  expect(result.body.result.structuredContent.error).toMatchObject({code,failure_class:classification,operation_state:state,next_action:action});
  expect(JSON.stringify(result.body)).not.toContain("DO_NOT_EXPOSE");
  expect(f.forwarded).toHaveLength(1);
});
it("R02 loses a post-dispatch reply without advising another command execution", async () => {
  const f=await fixture(()=>{throw new Error("synthetic reply lost");});
  const result=await f.call("shell",{workspace_id:"w",command:"synthetic"});
  expect(result.body.result.structuredContent.error).toMatchObject({operation_state:"unknown",next_action:"inspect_job"});
  expect(result.body.result.structuredContent.error.retry_after_ms).toBeUndefined();expect(f.forwarded).toHaveLength(1);
});
it("R02 authorization dependency failure proves nothing was sent", async () => {
  const f=await fixture();
  const original=f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get=(id:DurableObjectId)=>({fetch:(request:Request)=>new URL(request.url).pathname==="/auth/mcp/authorize-rpc"?Response.json({error:{code:"unavailable"}},{status:503}):original(id).fetch(request)});
  const result=await f.call("shell",{workspace_id:"w",command:"synthetic"});
  expect(result.body.result.structuredContent.error).toMatchObject({operation_state:"not_started",next_action:"wait_and_retry"});expect(f.forwarded).toHaveLength(0);
});
it("R02 a malformed or unsuccessful bridge success envelope is never treated as success", async () => {
  for(const reply of [()=>Response.json({type:"rpc.response"}),()=>Response.json({type:"rpc.response",result:{completed:true}},{status:503})]) {
    const f=await fixture(reply); const result=await f.call("shell",{workspace_id:"w",command:"synthetic"});
    expect(result.body.result.isError).toBe(true); expect(result.body.result.structuredContent.error.operation_state).toBe("unknown");
  }
});

it("R05 exposes v2 freshness status but never raw worktree details", () => {
  const record={schema_version:2,context_id:"c",workspace_id:"w",base_worktree_state:"clean",working_tree_state:"dirty",commit_state:"current",baseline_state:"stale",baseline_scope:"git-tracked-and-untracked-status",root_path:"/private",entries:[{path:"private"}]};
  const result=safeContextResult({context:record});
  expect(result.context).toMatchObject({schema_version:2,base_worktree_state:"clean",working_tree_state:"dirty",commit_state:"current",baseline_state:"stale",baseline_scope:"git-tracked-and-untracked-status"});
  expect(JSON.stringify(result)).not.toContain("private");
});


it("R02 a non-replayable operation state overrides the human-readable retry suggestion too", async () => {
  const f = await fixture(() => Response.json({ error: { code: "busy", operation_state: "unknown", retry_after_ms: 1000 } }, { status: 409 }));
  const result = await f.call("shell", { workspace_id: "w", command: "synthetic" });
  const error = result.body.result.structuredContent.error;
  expect(error).toMatchObject({ operation_state: "unknown", next_action: "inspect_job" });
  expect(error.retry_after_ms).toBeUndefined();
  expect(error.recovery_hint).toContain("do not repeat");
  expect(error.recovery_hint).not.toContain("then retry");
});


it("R02 a known offline selection fails before dispatch with a safe retry state", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (_instance, state) => { state.storage.sql.exec("UPDATE runners SET state='offline' WHERE runner_id='r'"); });
  const response = await f.call("shell", { workspace_id: "w", command: "synthetic" });
  expect(response.body.result.structuredContent.error).toMatchObject({ code: "runner_offline", operation_state: "not_started", next_action: "wait_and_retry" });
  expect(f.forwarded).toHaveLength(0);
});
