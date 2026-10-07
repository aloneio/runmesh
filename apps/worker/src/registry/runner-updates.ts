import { RunnerUpdateClaimSchema, RunnerUpdateDrainProofSchema, RunnerUpdateOperationSchema, RunnerUpdateStatusSchema, isTerminalRunnerUpdate, type RunnerUpdateOperation, type RunnerUpdateResponse, type RunnerUpdateState } from "@aloneio/runmesh-protocol";
import type { RegistryStorage } from "./storage.js";
import type { RunnerRow, InternalInput, RunnerRecord, RunnerUpdateChannel } from "./records.js";
import { observedRunnerState } from "../contracts/runner-selection.js";

type UpdateRow = { operation_json: string; claim_epoch: number | null; fingerprint: string };
export function ensureRunnerUpdatesSchema(sql: SqlStorage): void {
  const schema = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE (type = 'table' AND name = 'runner_updates') OR (type = 'index' AND name = 'idx_runner_updates_latest')").toArray().map(row => row.name));
  if (!schema.has("runner_updates")) sql.exec("CREATE TABLE runner_updates (runner_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_json TEXT NOT NULL, claim_epoch INTEGER, fingerprint TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, lifecycle_id, operation_id))");
  // SQLite's ascending rowid suffix is scanned backwards with created_at_ms,
  // preserving the latest-inserted tie break without discarding replay records.
  // Read before DDL: repeated DO construction must remain free of SQL writes.
  if (!schema.has("idx_runner_updates_latest")) sql.exec("CREATE INDEX idx_runner_updates_latest ON runner_updates(runner_id, lifecycle_id, created_at_ms)");
}

/** One active request per installation lifecycle. All decisions and writes are synchronous. */
export class RegistryRunnerUpdates {
  public constructor(private readonly storage: RegistryStorage, private readonly ports: {
    runnerRow(id: string): RunnerRow | undefined;
    setPolicy(id: string, input: { update_channel: RunnerUpdateChannel; desired_runner_version?: string; latest_runner_version?: string }, now: number): RunnerRecord | undefined;
  }) {}

  private latest(id: string, lifecycleId: string): UpdateRow | undefined {
    return this.storage.sql.exec<UpdateRow>("SELECT operation_json, claim_epoch, fingerprint FROM runner_updates WHERE runner_id = ? AND lifecycle_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1", id, lifecycleId).toArray()[0];
  }
  public response(id: string, now: number): RunnerUpdateResponse | undefined {
    const runner = this.ports.runnerRow(id);
    if (runner === undefined) return undefined;
    const row = this.latest(id, runner.lifecycle_id);
    const operation = row === undefined ? null : RunnerUpdateOperationSchema.parse(JSON.parse(row.operation_json));
    // A delayed alarm is not current evidence that the replacement is alive.
    // Observe liveness without making maintenance polling write Runner state.
    const online = observedRunnerState(runner.state, runner.last_heartbeat_ms, now) === "online" && runner.session_id !== null;
    return { operation, cloud_drained: false, cloud_uncertain: false, observed_version: online ? runner.current_runner_version : null,
      observed_new_session: online && row?.claim_epoch !== null && row?.claim_epoch !== undefined && runner.connection_epoch > row.claim_epoch };
  }
  public create(id: string, input: InternalInput, now: number): Response {
    const runner = this.ports.runnerRow(id);
    if (runner === undefined) return new Response("not found", { status: 404 });
    if (input.expected_lifecycle_id !== runner.lifecycle_id) return new Response("Runner lifecycle changed", { status: 409 });
    if (input.update_channel !== "stable" && input.update_channel !== "pinned") return new Response("invalid channel", { status: 400 });
    const parsed = RunnerUpdateOperationSchema.safeParse({ operation_id: input.operation_id, lifecycle_id: runner.lifecycle_id,
      target_version: input.target_version, target_channel: input.target_channel, manifest_sha256: input.manifest_sha256, artifact_sha256: input.artifact_sha256,
      original_version: runner.current_runner_version, manager_id: null, state: "queued", error_code: null, created_at_ms: now, updated_at_ms: now });
    if (!parsed.success || (parsed.data.target_version.includes("-dev.") ? "dev" : "stable") !== parsed.data.target_channel) return new Response("invalid exact release", { status: 400 });
    const operation = parsed.data;
    const fingerprint = JSON.stringify([input.update_channel, operation.target_version, operation.target_channel, operation.manifest_sha256, operation.artifact_sha256]);
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<UpdateRow>("SELECT operation_json, claim_epoch, fingerprint FROM runner_updates WHERE runner_id = ? AND lifecycle_id = ? AND operation_id = ?", id, runner.lifecycle_id, operation.operation_id).toArray()[0];
      const reused = this.storage.sql.exec<{ lifecycle_id: string }>("SELECT lifecycle_id FROM runner_updates WHERE runner_id = ? AND operation_id = ? AND lifecycle_id <> ? LIMIT 1", id, operation.operation_id, runner.lifecycle_id).toArray()[0];
      if (reused !== undefined) return new Response("update request belongs to a previous Runner lifecycle", { status: 409 });
      const latest = this.latest(id, runner.lifecycle_id);
      if (previous !== undefined) return previous.fingerprint === fingerprint && latest?.operation_json === previous.operation_json
        ? Response.json(this.response(id, now)) : new Response("update request changed", { status: 409 });
      if (latest !== undefined) {
        const current = RunnerUpdateOperationSchema.parse(JSON.parse(latest.operation_json));
        if (!isTerminalRunnerUpdate(current.state) || current.error_code === "rollback_failed") return new Response("Runner update already in progress or requires host recovery", { status: 409 });
      }
      this.ports.setPolicy(id, { update_channel: input.update_channel as RunnerUpdateChannel,
        ...(input.update_channel === "pinned" ? { desired_runner_version: operation.target_version } : { latest_runner_version: operation.target_version }) }, now);
      this.storage.sql.exec("INSERT INTO runner_updates (runner_id, lifecycle_id, operation_id, operation_json, claim_epoch, fingerprint, created_at_ms) VALUES (?, ?, ?, ?, NULL, ?, ?)", id, runner.lifecycle_id, operation.operation_id, JSON.stringify(operation), fingerprint, now);
      return Response.json(this.response(id, now));
    });
  }

  public handle(id: string, method: string, action: string | undefined, input: InternalInput, url: URL, now: number): Response {
    const runner = this.ports.runnerRow(id);
    const lifecycleId = method === "GET" ? url.searchParams.get("lifecycle_id") : input.auth_lifecycle_id;
    const credential = method === "GET" ? Number(url.searchParams.get("credential_version")) : input.auth_credential_version;
    if (runner === undefined || runner.lifecycle_id !== lifecycleId || runner.credential_version !== credential) return new Response("unauthorized", { status: 401 });
    if (method === "GET" && action === undefined) return Response.json(this.response(id, now));
    if (method === "GET" && action === "evidence") return Response.json({ update: this.response(id, now), claim_epoch: this.latest(id, runner.lifecycle_id)?.claim_epoch ?? null, connection_epoch: runner.connection_epoch });
    if (method !== "POST" || (action !== "claim" && action !== "status" && action !== "drain-proof")) return new Response("not found", { status: 404 });
    const { auth_lifecycle_id: _lifecycle, auth_credential_version: _credential, ...body } = input;
    const parsed = action === "claim" ? RunnerUpdateClaimSchema.safeParse(body) : action === "drain-proof" ? RunnerUpdateDrainProofSchema.safeParse(body) : RunnerUpdateStatusSchema.safeParse(body);
    if (!parsed.success) return new Response("invalid update request", { status: 400 });
    const current = this.response(id, now)!;
    const operation = current.operation;
    if (operation === null || parsed.data.operation_id !== operation.operation_id || parsed.data.lifecycle_id !== operation.lifecycle_id || operation.manager_id !== null && operation.manager_id !== parsed.data.manager_id) return new Response("update ownership changed", { status: 409 });
    if (action === "claim") {
      if (operation.manager_id === null && !isTerminalRunnerUpdate(operation.state)) {
        this.write(id, { ...operation, manager_id: parsed.data.manager_id, state: "verifying", original_version: runner.current_runner_version, updated_at_ms: now }, runner.connection_epoch);
      }
      return Response.json(this.response(id, now));
    }
    if (action === "drain-proof") {
      const baseline = this.latest(id, runner.lifecycle_id)?.claim_epoch;
      return operation.manager_id === parsed.data.manager_id && ["draining", "installing"].includes(operation.state) && baseline !== null && baseline !== undefined && runner.connection_epoch <= baseline
        ? Response.json(current) : new Response("Runner drain evidence changed", { status: 409 });
    }
    const status = RunnerUpdateStatusSchema.parse(body);
    if (operation.manager_id !== status.manager_id) return new Response("update not claimed", { status: 409 });
    if (operation.state === status.state && operation.error_code === (status.error_code ?? null)) return Response.json(current);
    if (operation.state === status.state && !isTerminalRunnerUpdate(operation.state)) {
      this.write(id, { ...operation, error_code: status.error_code ?? null, updated_at_ms: now });
      return Response.json(this.response(id, now));
    }
    if (isTerminalRunnerUpdate(operation.state) || !transitionAllowed(operation.state, status.state)) return new Response("invalid update transition", { status: 409 });
    if (status.state === "succeeded" || status.state === "rolled_back") {
      const expected = status.state === "succeeded" ? operation.target_version : operation.original_version;
      if (!current.observed_new_session || expected === null || current.observed_version !== expected) return new Response("new authenticated Runner version not observed", { status: 409 });
    }
    this.write(id, { ...operation, state: status.state, error_code: status.error_code ?? null, updated_at_ms: now });
    return Response.json(this.response(id, now));
  }
  private write(id: string, operation: RunnerUpdateOperation, epoch?: number): void {
    this.storage.sql.exec("UPDATE runner_updates SET operation_json = ?, claim_epoch = COALESCE(?, claim_epoch) WHERE runner_id = ? AND lifecycle_id = ? AND operation_id = ?", JSON.stringify(operation), epoch ?? null, id, operation.lifecycle_id, operation.operation_id);
  }
}

function transitionAllowed(from: RunnerUpdateState, to: RunnerUpdateState): boolean {
  if (to === "failed") return true;
  if (to === "rolled_back") return from === "installing" || from === "checking";
  const order: RunnerUpdateState[] = ["queued", "verifying", "draining", "installing", "checking", "succeeded"];
  return order.indexOf(to) === order.indexOf(from) + 1;
}
