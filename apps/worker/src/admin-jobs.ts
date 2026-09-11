import { isSafeIdentifier } from "./security.js";

export const JOBS_EXPLANATION = "Shell jobs are command executions, not all MCP calls. Read, search and edit operations appear in Recent MCP calls.";
export const JOBS_SNAPSHOT_NOTE = "Database snapshot; refreshed only when you open or refresh this page. Stored status may be stale while the Runner is offline.";
export function jobSnapshotNote(): string {
  const loadedAt = new Date().toISOString();
  return `<p class="muted font-12">${JOBS_SNAPSHOT_NOTE}</p><p class="muted font-12"><span>Last loaded</span>: <time datetime="${loadedAt}">${loadedAt}</time></p>`;
}

const LOG_LIMIT = 16 * 1024;

type JobPage = { readonly ok: true; readonly title: string; readonly body: string }
  | { readonly ok: false; readonly status: 400 | 404 | 503; readonly message: string };
type ReadRegistry = (path: string) => Promise<Response>;
type ReadLogs = (params: Record<string, unknown>) => Promise<Response | undefined>;

export function adminJobUrl(runnerId: unknown, jobId: unknown): string | undefined {
  return typeof runnerId === "string" && isSafeIdentifier(runnerId) && typeof jobId === "string" && isSafeIdentifier(jobId)
    ? `/admin/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}` : undefined;
}

/** Metadata is read from Registry. Only an explicit stream link contacts the Runner. */
export async function loadAdminJobPage(url: URL, runnerId: string, jobId: string, readRegistry: ReadRegistry, readLogs: ReadLogs): Promise<JobPage> {
  const path = adminJobUrl(runnerId, jobId);
  const stream = url.searchParams.get("stream");
  const cursor = url.searchParams.get("cursor");
  if (path === undefined || url.searchParams.getAll("stream").length > 1 || url.searchParams.getAll("cursor").length > 1
    || (stream !== null && stream !== "stdout" && stream !== "stderr")
    || (cursor !== null && (stream === null || !validCursor(cursor)))) {
    return { ok: false, status: 400, message: "Invalid job log query." };
  }
  let runnerResponse: Response;
  let jobResponse: Response;
  try {
    [runnerResponse, jobResponse] = await Promise.all([
      readRegistry(`/runners/${encodeURIComponent(runnerId)}`),
      readRegistry(`/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}`),
    ]);
  } catch { return { ok: false, status: 503, message: "Job metadata is temporarily unavailable." }; }
  if (runnerResponse.status === 404 || jobResponse.status === 404) return { ok: false, status: 404, message: "Job was not found." };
  if (!runnerResponse.ok || !jobResponse.ok) return { ok: false, status: 503, message: "Job metadata is temporarily unavailable." };
  const runner = await responseRecord(runnerResponse);
  const job = await responseRecord(jobResponse);
  if (runner === undefined || job === undefined || job.job_id !== jobId || job.runner_id !== runnerId
    || typeof job.workspace_id !== "string" || !isSafeIdentifier(job.workspace_id)) {
    return { ok: false, status: 503, message: "Job metadata is temporarily unavailable." };
  }

  let logPanel = '<p class="muted">Logs stay on the Runner and are fetched only when you select a stream. No automatic polling.</p>';
  if (stream !== null) {
    logPanel = '<p class="muted">Logs are unavailable. The Runner must be online with read permission, an applied policy and retained local logs.</p>';
    if (runner.state === "online") {
      try {
        const response = await readLogs({ job_id: jobId, expected_workspace_id: job.workspace_id, stream, limit: LOG_LIMIT, ...(cursor === null ? {} : { cursor }) });
        const envelope = response?.ok ? await responseRecord(response) : undefined;
        const result = record(envelope?.result);
        if (result?.job_id === jobId && result.stream === stream && typeof result.data === "string") {
          const next = typeof result.next_cursor === "string" && validCursor(result.next_cursor) && Number(result.next_cursor) > Number(cursor ?? 0) ? result.next_cursor : undefined;
          logPanel = `<h3>${escapeHtml(stream)}</h3><pre class="code-block" style="white-space:pre-wrap;overflow-wrap:anywhere"><code>${escapeHtml(result.data.slice(0, LOG_LIMIT))}</code></pre>${next === undefined ? "" : `<a class="button secondary" href="${escapeHtml(`${path}?stream=${stream}&cursor=${next}`)}">Next log chunk</a>`}`;
        }
      } catch { /* Local logs are best effort; keep the saved metadata visible. */ }
    }
  }
  // Do not render the raw record: future producer changes must not expose
  // commands, host paths or unapproved fields through this metadata view.
  const fields: readonly (readonly [string, unknown])[] = [
    ["Job", jobId], ["Workspace", job.workspace_id], ["MCP client", job.created_by_client_id ?? "—"],
    ["Status", job.status], ["Created", timestamp(job.created_at_ms)], ["Updated", timestamp(job.updated_at_ms)],
    ["Runner state", runner.state],
  ];
  const refresh = `${path}${stream === null ? "" : `?stream=${stream}${cursor === null ? "" : `&cursor=${cursor}`}`}`;
  return {
    ok: true,
    title: `Job details · ${jobId}`,
    body: `<section class="page-heading"><div><h1>Job details</h1><p class="lede">${JOBS_EXPLANATION}</p></div><a class="button secondary" href="${escapeHtml(refresh)}">Refresh</a></section><p><a href="/admin/runners/${encodeURIComponent(runnerId)}">Back to Runner</a></p><section class="panel">${jobSnapshotNote()}<div class="table-wrap"><table class="data-table"><tbody>${fields.map(([label, value]) => `<tr><th>${label}</th><td class="mono">${escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>Job logs</h2><p><a class="button secondary" href="${path}?stream=stdout">Read stdout</a> <a class="button secondary" href="${path}?stream=stderr">Read stderr</a></p>${logPanel}</section>`,
  };
}

function validCursor(value: string): boolean { return /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)); }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
async function responseRecord(response: Response): Promise<Record<string, unknown> | undefined> { try { return record(await response.json()); } catch { return undefined; } }
function timestamp(value: unknown): string { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : "—"; }
function escapeHtml(value: unknown): string { return String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
