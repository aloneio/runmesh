import { occupiesProcessSlot, type JobRecord } from "./records.js";

/** Returns original record identities, never authority to delete them. The
 * coordinator must revalidate each identity before and after every I/O. */
export function retainedJobCandidates(jobs: Iterable<JobRecord>, aliveJobIds: ReadonlySet<string>): JobRecord[] {
  return [...jobs].filter(job => !occupiesProcessSlot(job) && !aliveJobIds.has(job.job_id))
    .sort((a, b) => a.updated_at_ms - b.updated_at_ms || a.job_id.localeCompare(b.job_id));
}
export function expiredRetainedJob(job: JobRecord, cutoff: number): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status) && (job.completed_at_ms ?? job.updated_at_ms) <= cutoff;
}
