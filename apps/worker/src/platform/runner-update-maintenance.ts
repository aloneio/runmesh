import { RunnerUpdateResponseSchema, isTerminalRunnerUpdate } from "@aloneio/runmesh-protocol";
import { isSafeIdentifier } from "../security.js";
import type { RegistryRequestPort } from "../contracts/runner-transport.js";

const MAINTENANCE_KEY = "runner-update-maintenance-v1";
const UNCERTAIN_KEY = "runner-update-uncertain-rpc-v1";
type Owner = { operation_id: string; lifecycle_id: string; proven_epoch?: number };
type Uncertain = { lifecycle_id: string; epoch: number; session_id: string };
export interface MaintenanceConnection {
  readonly lifecycle_id: string;
  readonly epoch: number;
  readonly session_id: string;
  readonly pending: number;
  readonly open: boolean;
}
export class RunnerUpdateMaintenance {
  private owner: Owner | null | undefined;
  private uncertainties: Record<string, Uncertain> = {};
  private loading: Promise<void> | undefined;
  private persisted = false;
  private uncertainPersisted = false;
  private writes: Promise<void> = Promise.resolve();
  public constructor(private readonly ports: {
    storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
    registry: RegistryRequestPort;
    connections(): readonly MaintenanceConnection[];
    pendingReplies(): number;
  }) {}
  public get blocked(): boolean { return this.owner !== null; }
  /** An authenticated replacement installation never inherits the previous lifecycle's gate. */
  public blocksLifecycle(lifecycleId: string): boolean { return this.owner === undefined || this.owner?.lifecycle_id === lifecycleId; }
  public async load(): Promise<void> {
    if (this.owner !== undefined) return;
    this.loading ??= Promise.all([this.ports.storage.get<Owner>(MAINTENANCE_KEY), this.ports.storage.get<Record<string, Uncertain>>(UNCERTAIN_KEY)]).then(([owner, uncertainties]) => {
      this.owner = owner ?? null; this.uncertainties = uncertainties ?? {}; this.persisted = true; this.uncertainPersisted = true;
    }).catch(error => {
      // A transient read must remain fail-closed for this request, without poisoning every later request in the isolate.
      this.loading = undefined;
      throw error;
    });
    await this.loading;
  }
  private matches(owner: Owner): boolean { return this.owner?.operation_id === owner.operation_id && this.owner.lifecycle_id === owner.lifecycle_id; }
  private observation(owner: Owner) {
    const matches = this.matches(owner);
    const uncertain = matches && this.uncertainties[owner.lifecycle_id] !== undefined;
    return { cloud_uncertain: uncertain, cloud_drained: matches && this.persisted && !uncertain && this.ports.pendingReplies() === 0
      && this.ports.connections().every(connection => connection.lifecycle_id !== owner.lifecycle_id || connection.pending === 0 || !connection.open && (this.owner?.proven_epoch ?? -1) >= connection.epoch) };
  }
  public async disconnected(connection: MaintenanceConnection): Promise<void> {
    if (connection.pending === 0) return;
    await this.load();
    const work = this.writes.then(async () => {
      // A delayed close callback from the process already proved stopped must not resurrect uncertainty.
      if (this.owner?.lifecycle_id === connection.lifecycle_id && (this.owner.proven_epoch ?? -1) >= connection.epoch) return;
      const current = this.uncertainties[connection.lifecycle_id];
      if (current !== undefined && current.epoch >= connection.epoch && this.uncertainPersisted) return;
      if (current === undefined || current.epoch < connection.epoch) this.uncertainties[connection.lifecycle_id] = { lifecycle_id: connection.lifecycle_id, epoch: connection.epoch, session_id: connection.session_id };
      this.uncertainPersisted = false;
      await this.ports.storage.put(UNCERTAIN_KEY, this.uncertainties); this.uncertainPersisted = true;
    });
    this.writes = work.catch(() => undefined); await work;
  }

  /** The caller verifies the internal HMAC before reaching this handler. */
  public async handle(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url); const action = url.pathname.slice("/update-maintenance/".length);
    if (request.method !== (action === "read" ? "GET" : "POST") || !["read", "begin", "finish", "drain-proof"].includes(action)) return new Response("not found", { status: 404 });
    await this.load();
    if (action === "read") return Response.json(this.observation({ operation_id: url.searchParams.get("operation_id") ?? "", lifecycle_id: url.searchParams.get("lifecycle_id") ?? "" }));
    let input: Record<string, unknown>; try { input = JSON.parse(body) as Record<string, unknown>; } catch { return new Response("invalid update identity", { status: 400 }); }
    if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.runner_id !== "string" || !isSafeIdentifier(input.runner_id) || typeof input.operation_id !== "string" || !isSafeIdentifier(input.operation_id) || typeof input.lifecycle_id !== "string" || !isSafeIdentifier(input.lifecycle_id) || typeof input.manager_id !== "string" || !isSafeIdentifier(input.manager_id) || !Number.isSafeInteger(input.credential_version)) return new Response("invalid update identity", { status: 400 });
    let response = new Response("update state unavailable", { status: 503 });
    const work = this.writes.then(async () => {
      const receipt = await this.ports.registry(input.runner_id as string, `/update/evidence?lifecycle_id=${encodeURIComponent(input.lifecycle_id as string)}&credential_version=${input.credential_version}`, { method: "GET" });
      if (!receipt.ok) { response = receipt; return; }
      const evidence = await receipt.json() as { update?: unknown; claim_epoch?: unknown; connection_epoch?: unknown };
      const parsed = RunnerUpdateResponseSchema.safeParse(evidence.update);
      const operation = parsed.success ? parsed.data.operation : null;
      if (operation === null || operation.operation_id !== input.operation_id || operation.lifecycle_id !== input.lifecycle_id || operation.manager_id !== input.manager_id
        || isTerminalRunnerUpdate(operation.state) !== (action === "finish") || action === "finish" && operation.error_code === "rollback_failed") { response = new Response("update ownership changed", { status: 409 }); return; }
      const owner = { operation_id: operation.operation_id, lifecycle_id: operation.lifecycle_id };
      const matches = this.matches(owner);
      if (action === "begin" && (!matches || !this.persisted)) {
        // Set the local gate before awaiting storage, and retry uncertain writes on the next claim.
        this.owner = owner; this.persisted = false;
        await this.ports.storage.put(MAINTENANCE_KEY, owner); this.persisted = true;
      } else if (action === "finish" && matches) {
        await this.ports.storage.delete(MAINTENANCE_KEY); this.owner = null;
      } else if (action === "drain-proof") {
        const epoch = evidence.claim_epoch;
        const uncertain = this.uncertainties[owner.lifecycle_id];
        const hasNewOrOpenConnection = () => this.ports.connections().some(connection => connection.lifecycle_id === owner.lifecycle_id && (connection.open || connection.epoch > (epoch as number)));
        if (!matches || !["draining", "installing"].includes(operation.state) || input.old_process_stopped !== true || typeof epoch !== "number" || !Number.isSafeInteger(epoch)
          || typeof evidence.connection_epoch !== "number" || evidence.connection_epoch > epoch || this.ports.pendingReplies() !== 0 || hasNewOrOpenConnection()
          || uncertain === undefined && this.owner?.proven_epoch !== epoch
          || uncertain !== undefined && uncertain.epoch > epoch) { response = new Response("Runner drain evidence changed", { status: 409 }); return; }
        if (this.owner?.proven_epoch !== epoch || !this.persisted) {
          this.owner = { ...owner, proven_epoch: epoch }; this.persisted = false;
          await this.ports.storage.put(MAINTENANCE_KEY, this.owner); this.persisted = true;
        }
        if (uncertain !== undefined) {
          const remaining = { ...this.uncertainties }; delete remaining[owner.lifecycle_id];
          if (Object.keys(remaining).length === 0) await this.ports.storage.delete(UNCERTAIN_KEY);
          else await this.ports.storage.put(UNCERTAIN_KEY, remaining);
          this.uncertainties = remaining; this.uncertainPersisted = true;
        }
        // A new hello can race storage I/O. Never authorize a switch across that new session.
        if (this.ports.pendingReplies() !== 0 || hasNewOrOpenConnection()) { response = new Response("Runner drain evidence changed", { status: 409 }); return; }
      }
      response = Response.json(this.observation(owner));
    });
    this.writes = work.catch(() => undefined); await work; return response;
  }
}
