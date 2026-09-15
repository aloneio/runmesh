import { BytePageMetadataSchema } from "@aloneio/runmesh-protocol";

/** White-list only complete, internally consistent page evidence. Older
 * peers keep the existing byte-cursor contract; absent fields are not filled
 * with invented totals or an unobserved snapshot guarantee.
 */
export function projectBytePageMetadata(value: Record<string, unknown>, output: Record<string, unknown>): void {
  if (value.page_protocol !== 1 || typeof output.data !== "string") return;
  const parsed = BytePageMetadataSchema.safeParse({
    page_protocol: value.page_protocol, page_state: value.page_state,
    returned_bytes: value.returned_bytes, total_bytes: value.total_bytes,
    resume_offset: value.resume_offset, pending_bytes: value.pending_bytes,
    truncated_reason: value.truncated_reason, snapshot_id: value.snapshot_id,
  });
  if (!parsed.success) return;
  const page = parsed.data;
  const offset = output.offset;
  if (typeof offset !== "number" || page.total_bytes !== output.size || page.returned_bytes !== new TextEncoder().encode(output.data).byteLength
    || page.resume_offset < offset || page.resume_offset > page.total_bytes || page.resume_offset - offset > page.returned_bytes) return;
  if (page.page_state === "more") {
    if (page.resume_offset <= offset || page.resume_offset >= page.total_bytes || output.next_cursor !== String(page.resume_offset) || output.truncated !== true || page.pending_bytes !== 0 || !["page_limit", "response_bytes"].includes(page.truncated_reason ?? "")) return;
  } else if (page.page_state === "end") {
    if (page.resume_offset !== page.total_bytes || output.next_cursor !== null || output.truncated !== false || page.pending_bytes !== 0 || page.truncated_reason !== null) return;
  } else {
    if (page.resume_offset !== offset || page.pending_bytes !== page.total_bytes - offset || page.pending_bytes === 0 || output.data !== "" || output.next_cursor !== null || output.truncated !== true || page.truncated_reason !== "incomplete_utf8") return;
  }
  Object.assign(output, page);
}
