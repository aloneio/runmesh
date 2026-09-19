import { BytePageMetadataSchema, BoundBytePageMetadataSchema, isBoundCursor } from "@aloneio/runmesh-protocol";

/** White-list only complete, internally consistent page evidence. Older
 * peers keep the existing byte-cursor contract; absent fields are not filled
 * with invented totals or an unobserved snapshot guarantee.
 */
export function projectBytePageMetadata(value: Record<string, unknown>, output: Record<string, unknown>, kind?: "file" | "log"): void {
  if ((value.page_protocol !== 1 && value.page_protocol !== 2) || typeof output.data !== "string") return;
  const bound = value.page_protocol === 2;
  const parsed = (bound ? BoundBytePageMetadataSchema : BytePageMetadataSchema).safeParse({
    page_protocol: value.page_protocol, page_state: value.page_state,
    returned_bytes: value.returned_bytes, total_bytes: value.total_bytes,
    resume_offset: value.resume_offset, pending_bytes: value.pending_bytes,
    truncated_reason: value.truncated_reason, snapshot_id: value.snapshot_id,
    ...(bound ? { consistency: value.consistency, resume_cursor: value.resume_cursor, cursor_expires_at_ms: value.cursor_expires_at_ms } : {}),
  });
  if (!parsed.success) return;
  const page = parsed.data;
  const mode = "consistency" in page ? page.consistency : undefined;
  const resume = "resume_cursor" in page ? page.resume_cursor : undefined;
  if (bound && (mode !== (kind === "file" ? "snapshot" : kind === "log" ? "append" : mode)
    || !isBoundCursor(resume, mode === "snapshot" ? "file" : "log")
    || Number(resume.slice(resume.lastIndexOf(":") + 1)) !== page.resume_offset
    || (mode === "append" && resume.split(":")[1] !== page.snapshot_id))) return;
  const nextCursor = bound ? value.next_cursor : output.next_cursor;
  const offset = output.offset;
  if (typeof offset !== "number" || page.total_bytes !== output.size || page.returned_bytes !== new TextEncoder().encode(output.data).byteLength
    || page.resume_offset < offset || page.resume_offset > page.total_bytes || page.resume_offset - offset > page.returned_bytes) return;
  if (page.page_state === "more") {
    if (page.resume_offset <= offset || page.resume_offset >= page.total_bytes || nextCursor !== (bound ? resume : String(page.resume_offset)) || output.truncated !== true || page.pending_bytes !== 0 || !["page_limit", "response_bytes"].includes(page.truncated_reason ?? "")) return;
  } else if (page.page_state === "end") {
    if (page.resume_offset !== page.total_bytes || nextCursor !== null || output.truncated !== false || page.pending_bytes !== 0 || page.truncated_reason !== null) return;
  } else {
    if (page.resume_offset !== offset || page.pending_bytes !== page.total_bytes - offset || page.pending_bytes === 0 || output.data !== "" || nextCursor !== null || output.truncated !== true || page.truncated_reason !== "incomplete_utf8") return;
  }
  Object.assign(output, page);
  if (bound) output.next_cursor = nextCursor;
}

/** Explicit consistency requests cannot silently degrade on old peers. This
 * validates transport evidence, not source authenticity or authorization. */
export function boundPageResponseProblem(method: string, params: Record<string, unknown>, value: unknown, projected: Record<string, unknown>): "runner_upgrade_required" | "cursor_mismatch" | undefined {
  if (method !== "fs.read" && method !== "job.logs") return undefined;
  const kind = method === "fs.read" ? "file" : "log";
  const mode = kind === "file" ? "snapshot" : "append";
  if (params.consistency !== mode && !isBoundCursor(params.cursor, kind)) return undefined;
  if (typeof value !== "object" || value === null || !("page_protocol" in value) || value.page_protocol !== 2) return "runner_upgrade_required";
  if (projected.page_protocol !== 2 || projected.consistency !== mode || !isBoundCursor(projected.resume_cursor, kind)) return "cursor_mismatch";
  if (isBoundCursor(params.cursor, kind)) {
    const parts = params.cursor.split(":");
    if (projected.resume_cursor.split(":")[1] !== parts[1] || typeof projected.offset !== "number" || projected.offset < Number(parts[2]) || projected.offset > Number(parts[2]) + 3) return "cursor_mismatch";
  }
  if (kind === "log") {
    if (projected.job_id !== params.job_id || projected.stream !== (params.stream ?? "stdout")) return "cursor_mismatch";
  } else {
    const relativePath = typeof params.path === "string" ? params.path.split(/[\\/]+/u).filter(part => part !== "" && part !== ".").join("/") : undefined;
    if (projected.workspace_id !== params.workspace_id || projected.path !== relativePath) return "cursor_mismatch";
  }
  return undefined;
}
