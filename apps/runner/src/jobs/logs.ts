import { boundPageRequest, bindBytePage, logGenerations, observeLog, verifyLogGeneration, changedLog } from "../bound-cursors.js";
import { RpcRuntimeError } from "../errors.js";
import { PathPolicyError } from "../path-policy.js";
import { PROTOCOL_CURRENT_VERSION, bytePageMetadata } from "@aloneio/runmesh-protocol";
import { readPageBytes, type PositionedByteReader } from "../page-read.js";
import { utf8BackwardBoundary, utf8ForwardBoundary, utf8SafePrefixLength } from "../utf8-pagination.js";
import { isErrno, bounded, paramsObject } from "./values.js";
import type { open } from "node:fs/promises";
import type { JobRecord } from "./records.js";
import type { JobLogFilePort, JobLogScope } from "./ports.js";

// Reserve room for the MCP context/audit envelope, as filesystem pages do.
// The transport ceiling remains 64 KiB; filling it locally would discard the
// continuation cursor when the Worker adds its own bounded metadata.
export const MAX_LOG_RESPONSE_BYTES = 48 * 1024;

export const MAX_LOG_READ_BYTES = 64 * 1024;

export function logResult(jobId: string, stream: "stdout" | "stderr", offset: number, size: number, data: string, next: number, responseLimited = false, sourceTruncated = false): Record<string, unknown> {
  return { job_id: jobId, stream, data, offset, size, ...bytePageMetadata(data, offset, next, size, responseLimited), source_truncated: sourceTruncated };
}

export function wireResponseBytes(result: Record<string, unknown>): number {
  // Include the largest supported request-id and JSON wire envelope so the
  // bounded local result stays under the documented 64 KiB response budget.
  return Buffer.byteLength(JSON.stringify({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "x".repeat(128), result }), "utf8");
}

export async function utf8AlignedStart(handle: PositionedByteReader, requested: number, size: number, preferBackward: boolean): Promise<number> {
  if (requested === 0 || requested >= size) return requested;
  const begin = Math.max(0, requested - 3);
  const data = await readPageBytes(handle, begin, Math.min(7, size - begin), "log_changed");
  const relative = requested - begin;
  return begin + (preferBackward ? utf8BackwardBoundary(data, relative) : utf8ForwardBoundary(data, relative));
}

/** A bounded reader; it cannot spawn, publish Job state or mutate retention. */
export class JobLogReader {
  public constructor(private readonly files: JobLogFilePort, private readonly scope: JobLogScope) {}
  public async read(job: JobRecord, input: unknown = {}): Promise<Record<string, unknown>> {
    const params = paramsObject(input);
    const cursor = boundPageRequest(params, "log");
    const generation = this.scope.generation();
    const stream = params.stream === "stderr" ? "stderr" : "stdout";
    const limit = bounded(params.limit, 1, MAX_LOG_READ_BYTES, 16 * 1024);
    const scope = JSON.stringify([this.scope.cursorOwner, this.scope.jobsDir, this.scope.runnerId, job.job_id, job.workspace_id, stream, generation]);
    let entry = cursor.id === undefined ? undefined : logGenerations.get(cursor.id, scope);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await this.files.openJobLog(this.scope.logPath(job.job_id, stream), "read");
    } catch (error) {
      const reason = isErrno(error, "ENOENT") ? "missing" : isErrno(error, "EACCES") || isErrno(error, "EPERM") ? "access_denied" : isErrno(error, "ENOTDIR") || isErrno(error, "ELOOP") ? "unsafe_path" : "io_error";
      throw new RpcRuntimeError("log_unavailable", "The requested log is unavailable; the Job execution result is unchanged", { reason });
    }
    try {
      const info = await handle.stat();
      if (entry !== undefined) await verifyLogGeneration(handle, info, entry.value);
      if (cursor.offset !== undefined && cursor.offset > info.size) throw changedLog();
      const observation = cursor.bound ? await observeLog(handle, info) : undefined;
      if (observation !== undefined && entry === undefined) entry = logGenerations.put(scope, observation, Buffer.byteLength(scope) + Buffer.byteLength(JSON.stringify(observation)) + 256);
      const requestedOffset = cursor.offset ?? bounded(params.cursor ?? params.offset, 0, info.size, 0);
      const requested = params.tail === true ? Math.max(0, info.size - limit) : requestedOffset;
      const offset = await utf8AlignedStart(handle, requested, info.size, params.tail === true);
      // Read enough bytes to finish one multibyte code point when a tiny caller
      // limit lands in its middle; the JSON response cap below remains absolute.
      const readLength = Math.min(info.size - offset, limit + 3);
      const data = await readPageBytes(handle, offset, readLength, "log_changed");
      const after = await handle.stat();
      const current = await this.files.lstat(this.scope.logPath(job.job_id, stream));
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || after.size < info.size || (after.size === info.size && (after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs))) throw new RpcRuntimeError("log_changed", "The log changed while this page was being read; request a fresh page");
      if (entry !== undefined && observation !== undefined) {
        await verifyLogGeneration(handle, after, observation);
        // Keep the largest successfully observed watermark across concurrent
        // reads. Growth alone is not a new log generation.
        const live = logGenerations.get(entry.id, scope);
        await verifyLogGeneration(handle, await handle.stat(), live.value);
        if (observation.size > live.value.size) Object.assign(live.value, observation);
      }
      const tail = params.tail === true;
      // Tail alignment can include up to three bytes before the requested
      // range. Keep that complete character together with the observed EOF.
      const maxByLimit = utf8SafePrefixLength(data, tail ? data.length : Math.min(limit, data.length));
      const pageLength = maxByLimit === 0 && data.length > 0 ? utf8SafePrefixLength(data, Math.min(4, data.length)) : maxByLimit;
      const used = this.fitLogResponse(job.job_id, stream, offset, info.size, data, pageLength, tail, entry);
      // A partial final code point stops automatic paging. Preserve its byte
      // offset for an explicit later refresh: appending the remaining bytes
      // must not lose a character merely because an earlier read saw EOF.
      const page = logResult(job.job_id, stream, offset + used.start, info.size, data.subarray(used.start, used.end).toString("utf8"), offset + used.end, used.end - used.start < pageLength, job.output_truncated);
      if (entry === undefined) return page;
      const finalPath = await this.files.lstat(this.scope.logPath(job.job_id, stream));
      if (!finalPath.isFile() || finalPath.isSymbolicLink() || finalPath.dev !== info.dev || finalPath.ino !== info.ino) throw changedLog();
      this.scope.assertGeneration(generation);
      logGenerations.get(entry.id, scope);
      return bindBytePage(page, entry, "log", entry.id);
    } catch (error) {
      if (entry !== undefined && error instanceof RpcRuntimeError && error.code === "log_changed") logGenerations.delete(entry.id);
      if (error instanceof RpcRuntimeError || error instanceof PathPolicyError) throw error;
      throw new RpcRuntimeError("log_unavailable", "The requested log could not be read; the Job execution result is unchanged", { reason: "io_error" });
    } finally {
      await handle.close();
    }
  }

  private fitLogResponse(jobId: string, stream: "stdout" | "stderr", offset: number, size: number, data: Buffer, initial: number, tail: boolean, entry?: { id: string; expiresAt: number }): { start: number; end: number } {
    const rangeFor = (length: number) => tail
      ? { start: Math.min(initial, utf8ForwardBoundary(data, initial - length)), end: initial }
      : { start: 0, end: utf8SafePrefixLength(data, length) };
    const pageFor = (length: number) => {
      const range = rangeFor(length);
      const page = logResult(jobId, stream, offset + range.start, size, data.subarray(range.start, range.end).toString("utf8"), offset + range.end, true);
      return entry === undefined ? page : bindBytePage(page, entry, "log", entry.id);
    };
    let low = 0;
    let high = initial;
    let best = 0;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = pageFor(midpoint);
      if (wireResponseBytes(candidate) <= MAX_LOG_RESPONSE_BYTES) {
        best = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    // A valid UTF-8 character always fits in a 64 KiB response; the fallback
    // protects this invariant even for hostile/corrupt raw log bytes.
    return rangeFor(best === 0 && initial > 0 && wireResponseBytes(pageFor(initial)) <= MAX_LOG_RESPONSE_BYTES ? initial : best);
  }
}
