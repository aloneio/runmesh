import {
  JobCompletedSchema,
  JobStartedSchema,
  JobStatusMessageSchema,
  IdentifierSchema,
  RunnerMetadataSchema,
  RunnerSyncSchema,
  type RunnerMetadata,
} from "@remote-coding-runtime/protocol";
import { constantTimeEqual, isSafeIdentifier, runnerTokenVerifier, verifyInternalRequest } from "./security.js";

export type RunnerConnectionState = "online" | "offline" | "stale";

export interface RunnerRecord {
  readonly runner_id: string;
  readonly state: RunnerConnectionState;
  readonly connection_epoch: number;
  readonly credential_version: number;
  readonly session_id: string | null;
  readonly metadata: RunnerMetadata | null;
  readonly last_heartbeat_ms: number | null;
  readonly last_sync_sequence: number | null;
  readonly updated_at_ms: number;
}

type RunnerRow = {
  runner_id: string;
  token_verifier: string;
  state: RunnerConnectionState;
  connection_epoch: number;
  credential_version: number;
  session_id: string | null;
  metadata_json: string | null;
  last_heartbeat_ms: number | null;
  last_sync_sequence: number | null;
  updated_at_ms: number;
};

type WorkspaceRow = { workspace_json: string };
type JobRow = { job_json: string };

type InternalInput = Record<string, unknown>;
const MAX_INTERNAL_BODY_BYTES = 1_048_576;
const MAX_SYNC_ITEMS = 1_000;

export class RegistryDO {
  public constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { INTERNAL_CONTROL_SECRET?: string; RUNNER_TOKEN_PEPPER?: string },
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runners (
          runner_id TEXT PRIMARY KEY,
          token_verifier TEXT NOT NULL,
          state TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL DEFAULT 0,
          credential_version INTEGER NOT NULL DEFAULT 1,
          session_id TEXT,
          metadata_json TEXT,
          last_heartbeat_ms INTEGER,
          last_sync_sequence INTEGER,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          runner_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          workspace_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (runner_id, workspace_id)
        );
        CREATE TABLE IF NOT EXISTS jobs (
          runner_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          job_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (runner_id, job_id)
        );
      `);
      this.ensureSchema();
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    });
  }

  public async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'stale', updated_at_ms = ?
       WHERE state = 'online' AND (last_heartbeat_ms IS NULL OR last_heartbeat_ms < ?)`,
      nowMs,
      nowMs - 45_000,
    );
    await this.ctx.storage.setAlarm(nowMs + 30_000);
  }

  public registerRunner(runnerId: string, tokenVerifier: string, nowMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO runners (runner_id, token_verifier, state, credential_version, updated_at_ms)
       VALUES (?, ?, 'offline', 1, ?)
       ON CONFLICT(runner_id) DO UPDATE SET
         token_verifier = excluded.token_verifier,
         credential_version = runners.credential_version + 1,
         connection_epoch = runners.connection_epoch + 1,
         state = 'offline', session_id = NULL, metadata_json = NULL,
         last_heartbeat_ms = NULL, last_sync_sequence = NULL, updated_at_ms = excluded.updated_at_ms`,
      runnerId,
      tokenVerifier,
      nowMs,
    );
  }

  public async authenticateRunner(runnerId: string, token: string): Promise<{ credential_version: number } | undefined> {
    if (this.env.RUNNER_TOKEN_PEPPER === undefined) return undefined;
    const tokenVerifier = await runnerTokenVerifier(token, this.env.RUNNER_TOKEN_PEPPER);
    const row = this.ctx.storage.sql
      .exec<Pick<RunnerRow, "token_verifier" | "credential_version">>(
        "SELECT token_verifier, credential_version FROM runners WHERE runner_id = ?",
        runnerId,
      )
      .toArray()[0];
    return row !== undefined && constantTimeEqual(row.token_verifier, tokenVerifier)
      ? { credential_version: row.credential_version }
      : undefined;
  }

  public beginConnection(
    runnerId: string,
    metadata: RunnerMetadata,
    sessionId: string,
    credentialVersion: number,
    nowMs: number,
  ): number | undefined {
    this.ctx.storage.sql.exec(
      `UPDATE runners
       SET state = 'online', connection_epoch = connection_epoch + 1, session_id = ?,
           metadata_json = ?, last_heartbeat_ms = ?, last_sync_sequence = NULL, updated_at_ms = ?
       WHERE runner_id = ? AND credential_version = ?`,
      sessionId,
      JSON.stringify(metadata),
      nowMs,
      nowMs,
      runnerId,
      credentialVersion,
    );
    return this.getRunner(runnerId)?.credential_version === credentialVersion
      ? this.getRunner(runnerId)?.connection_epoch
      : undefined;
  }

  public sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline = false): boolean {
    const row = this.ctx.storage.sql
      .exec<Pick<RunnerRow, "connection_epoch" | "credential_version" | "state">>(
        "SELECT connection_epoch, credential_version, state FROM runners WHERE runner_id = ?",
        runnerId,
      )
      .toArray()[0];
    return row?.connection_epoch === epoch && row.credential_version === credentialVersion && (!requireOnline || row.state === "online");
  }

  public recordHeartbeat(runnerId: string, epoch: number, credentialVersion: number, nowMs: number): boolean {
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'online', last_heartbeat_ms = ?, updated_at_ms = ?
       WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ?`,
      nowMs,
      nowMs,
      runnerId,
      epoch,
      credentialVersion,
    );
    return this.sessionIsCurrent(runnerId, epoch, credentialVersion, true);
  }

  public markDisconnected(
    runnerId: string,
    epoch: number,
    credentialVersion: number,
    state: Exclude<RunnerConnectionState, "online">,
    nowMs: number,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = ?, session_id = NULL, updated_at_ms = ?
       WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ?`,
      state,
      nowMs,
      runnerId,
      epoch,
      credentialVersion,
    );
  }

  public syncRunner(
    runnerId: string,
    epoch: number,
    credentialVersion: number,
    workspaces: readonly { readonly workspace_id: string }[],
    jobs: readonly { readonly job_id: string; readonly runner_id?: string | undefined }[],
    syncSequence: number,
    nowMs: number,
    requireOnline = true,
  ): boolean {
    if (!this.sessionIsCurrent(runnerId, epoch, credentialVersion, requireOnline)) return false;
    const prior = this.ctx.storage.sql.exec<Pick<RunnerRow, "last_sync_sequence">>("SELECT last_sync_sequence FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    if (prior?.last_sync_sequence !== null && prior?.last_sync_sequence !== undefined && syncSequence <= prior.last_sync_sequence) return false;
    this.ctx.storage.transactionSync(() => {
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspace_id));
      const jobIds = new Set(jobs.map((job) => job.job_id));
      for (const workspace of workspaces) {
        this.ctx.storage.sql.exec(
          `INSERT INTO workspaces (runner_id, workspace_id, workspace_json, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(runner_id, workspace_id) DO UPDATE SET workspace_json = excluded.workspace_json, updated_at_ms = excluded.updated_at_ms`,
          runnerId, workspace.workspace_id, JSON.stringify(workspace), nowMs,
        );
      }
      for (const job of jobs) {
        const normalized = { ...job, runner_id: runnerId };
        this.ctx.storage.sql.exec(
          `INSERT INTO jobs (runner_id, job_id, job_json, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(runner_id, job_id) DO UPDATE SET job_json = excluded.job_json, updated_at_ms = excluded.updated_at_ms`,
          runnerId, normalized.job_id, JSON.stringify(normalized), nowMs,
        );
      }
      this.deleteMissing("workspaces", "workspace_id", runnerId, workspaceIds);
      this.deleteMissing("jobs", "job_id", runnerId, jobIds);
      this.ctx.storage.sql.exec("UPDATE runners SET last_sync_sequence = ?, updated_at_ms = ? WHERE runner_id = ?", syncSequence, nowMs, runnerId);
    });
    return true;
  }

  public revokeRunner(runnerId: string, nowMs: number): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
         token_verifier = '', state = 'offline', session_id = NULL, metadata_json = NULL, last_heartbeat_ms = NULL, last_sync_sequence = NULL, updated_at_ms = ?
         WHERE runner_id = ?`,
        nowMs, runnerId,
      );
      this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM jobs WHERE runner_id = ?", runnerId);
    });
  }

  public recordJobEvent(runnerId: string, epoch: number, credentialVersion: number, message: unknown, nowMs: number, requireOnline = true): boolean {
    if (!this.sessionIsCurrent(runnerId, epoch, credentialVersion, requireOnline)) return false;
    const event = parseJobEvent(message);
    if (event === undefined || event.job.runner_id !== runnerId) return false;
    // job.output is deliberately not persisted: complete logs remain local and
    // unbounded by default. Started/status/completed provide durable metadata.
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (runner_id, job_id, job_json, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(runner_id, job_id) DO UPDATE SET job_json = excluded.job_json, updated_at_ms = excluded.updated_at_ms`,
      runnerId, event.job.job_id, JSON.stringify({ ...event.job, runner_id: runnerId }), nowMs,
    );
    return true;
  }

  public getRunner(runnerId: string): RunnerRecord | undefined {
    const staleBefore = Date.now() - 45_000;
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'stale', updated_at_ms = ?
       WHERE runner_id = ? AND state = 'online' AND last_heartbeat_ms < ?`,
      Date.now(), runnerId, staleBefore,
    );
    const row = this.ctx.storage.sql
      .exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId)
      .toArray()[0];
    return row === undefined ? undefined : decodeRunner(row);
  }

  public listWorkspaces(runnerId: string): unknown[] {
    return this.ctx.storage.sql.exec<WorkspaceRow>(
      "SELECT workspace_json FROM workspaces WHERE runner_id = ? ORDER BY workspace_id", runnerId,
    ).toArray().map((row) => JSON.parse(row.workspace_json) as unknown);
  }

  public listJobs(runnerId: string): unknown[] {
    return this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_json FROM jobs WHERE runner_id = ? ORDER BY job_id", runnerId,
    ).toArray().map((row) => JSON.parse(row.job_json) as unknown);
  }

  public listRunners(): RunnerRecord[] {
    return this.ctx.storage.sql.exec<RunnerRow>("SELECT * FROM runners ORDER BY runner_id").toArray().map(decodeRunner);
  }

  public getJob(runnerId: string, jobId: string): unknown | undefined {
    const row = this.ctx.storage.sql.exec<JobRow>(
      "SELECT job_json FROM jobs WHERE runner_id = ? AND job_id = ?", runnerId, jobId,
    ).toArray()[0];
    return row === undefined ? undefined : JSON.parse(row.job_json) as unknown;
  }

  public async fetch(request: Request): Promise<Response> {
    const rawBody = await readCappedBody(request);
    if (rawBody === undefined) return new Response("payload too large", { status: 413 });
    if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, rawBody)) {
      return new Response("not found", { status: 404 });
    }
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && segments.length === 1 && segments[0] === "runners") {
      return Response.json({ runners: this.listRunners() });
    }
    const runnerId = segments[0] === "runners" ? parseRunnerId(segments[1]) : undefined;
    const action = segments[2];
    const itemId = segments[3];
    if (runnerId === undefined || segments.length > 4) return new Response("not found", { status: 404 });

    const input = rawBody.length === 0 ? {} : parseJsonObject(rawBody);
    if (input === undefined) return Response.json({ error: "invalid JSON object" }, { status: 400 });
    const now = Date.now();
    if (request.method === "PUT" && action === undefined) {
      const tokenVerifier = stringField(input, "token_verifier", 64);
      if (tokenVerifier === undefined || !/^[0-9a-f]{64}$/.test(tokenVerifier)) {
        return Response.json({ error: "invalid token verifier" }, { status: 400 });
      }
      this.registerRunner(runnerId, tokenVerifier, now);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "auth") {
      const token = stringField(input, "token", 512);
      if (token === undefined || /\s/.test(token)) return new Response("unauthorized", { status: 401 });
      const authenticated = await this.authenticateRunner(runnerId, token);
      return authenticated === undefined ? new Response("unauthorized", { status: 401 }) : Response.json(authenticated);
    }
    if (request.method === "POST" && action === "connect") {
      const sessionId = stringField(input, "session_id", 128);
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      const metadata = RunnerMetadataSchema.safeParse(input.metadata);
      if (!metadata.success || sessionId === undefined || credentialVersion === undefined || nowMs === undefined) {
        return Response.json({ error: "invalid connection metadata" }, { status: 400 });
      }
      const epoch = this.beginConnection(runnerId, metadata.data, sessionId, credentialVersion, nowMs);
      return epoch === undefined ? new Response("stale credentials", { status: 409 }) : Response.json({ epoch });
    }
    if (request.method === "POST" && action === "heartbeat") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined) return Response.json({ error: "invalid heartbeat" }, { status: 400 });
      return this.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs)
        ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 });
    }
    if (request.method === "POST" && action === "session") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      return epoch !== undefined && credentialVersion !== undefined && this.sessionIsCurrent(runnerId, epoch, credentialVersion)
        ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 });
    }
    if (request.method === "POST" && action === "disconnect") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || (input.state !== "offline" && input.state !== "stale")) return Response.json({ error: "invalid disconnect" }, { status: 400 });
      this.markDisconnected(runnerId, epoch, credentialVersion, input.state, nowMs);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "sync") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      const message = RunnerSyncSchema.safeParse(input.message);
      if (!message.success || epoch === undefined || credentialVersion === undefined || nowMs === undefined || message.data.runner_id !== runnerId || message.data.workspaces.length > MAX_SYNC_ITEMS || message.data.jobs.length > MAX_SYNC_ITEMS || !uniqueIds(message.data.workspaces.map((workspace) => workspace.workspace_id)) || !uniqueIds(message.data.jobs.map((job) => job.job_id))) return Response.json({ error: "invalid sync" }, { status: 400 });
      return this.syncRunner(runnerId, epoch, credentialVersion, message.data.workspaces, message.data.jobs, message.data.sync_sequence, nowMs)
        ? new Response(null, { status: 204 }) : new Response("stale sync or session", { status: 409 });
    }
    if (request.method === "POST" && action === "event") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !this.recordJobEvent(runnerId, epoch, credentialVersion, input.message, nowMs)) return new Response("stale session or invalid event", { status: 409 });
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "revoke") {
      this.revokeRunner(runnerId, now);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && action === "workspaces" && itemId === undefined) {
      return Response.json({ runner_id: runnerId, workspaces: this.listWorkspaces(runnerId) });
    }
    if (request.method === "GET" && action === "jobs" && itemId !== undefined && IdentifierSchema.safeParse(itemId).success) {
      const job = this.getJob(runnerId, itemId);
      return job === undefined ? Response.json({ error: "job not found" }, { status: 404 }) : Response.json(job);
    }
    if (request.method === "GET" && action === undefined && itemId === undefined) {
      const runner = this.getRunner(runnerId);
      return runner === undefined ? Response.json({ error: "runner not found" }, { status: 404 }) : Response.json(runner);
    }
    return new Response("not found", { status: 404 });
  }

  private ensureSchema(): void {
    const columns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(runners)").toArray();
    if (!columns.some((column) => column.name === "token_verifier")) {
      this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN token_verifier TEXT");
      this.ctx.storage.sql.exec("UPDATE runners SET token_verifier = token_hash WHERE token_verifier IS NULL");
    }
    if (!columns.some((column) => column.name === "credential_version")) {
      this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.some((column) => column.name === "last_sync_sequence")) {
      this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN last_sync_sequence INTEGER");
    }
  }

  private deleteMissing(table: "workspaces" | "jobs", idColumn: "workspace_id" | "job_id", runnerId: string, ids: ReadonlySet<string>): void {
    const rows = this.ctx.storage.sql.exec<{ id: string }>(`SELECT ${idColumn} AS id FROM ${table} WHERE runner_id = ?`, runnerId).toArray();
    for (const row of rows) {
      if (!ids.has(row.id)) this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE runner_id = ? AND ${idColumn} = ?`, runnerId, row.id);
    }
  }
}

function decodeRunner(row: RunnerRow): RunnerRecord {
  return {
    runner_id: row.runner_id, state: row.state, connection_epoch: row.connection_epoch,
    credential_version: row.credential_version, session_id: row.session_id,
    metadata: row.metadata_json === null ? null : (JSON.parse(row.metadata_json) as RunnerMetadata),
    last_heartbeat_ms: row.last_heartbeat_ms, last_sync_sequence: row.last_sync_sequence, updated_at_ms: row.updated_at_ms,
  };
}

function parseJobEvent(value: unknown): { job: { job_id: string; runner_id?: string | undefined } } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as { type?: unknown };
  const parsed = input.type === "job.started" ? JobStartedSchema.safeParse(value)
    : input.type === "job.status" ? JobStatusMessageSchema.safeParse(value)
      : input.type === "job.completed" ? JobCompletedSchema.safeParse(value)
        : undefined;
  return parsed?.success ? { job: parsed.data.job } : undefined;
}

function uniqueIds(values: readonly string[]): boolean { return new Set(values).size === values.length; }

function parseRunnerId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return isSafeIdentifier(decoded) && IdentifierSchema.safeParse(decoded).success ? decoded : undefined;
  } catch { return undefined; }
}

async function readCappedBody(request: Request): Promise<string | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_INTERNAL_BODY_BYTES)) return undefined;
  const body = await request.text();
  return new TextEncoder().encode(body).byteLength <= MAX_INTERNAL_BODY_BYTES ? body : undefined;
}

function parseJsonObject(body: string): InternalInput | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as InternalInput : undefined;
  } catch { return undefined; }
}

function stringField(input: InternalInput, field: string, maxLength: number): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}
function integerField(input: InternalInput, field: string): number | undefined {
  const value = input[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
