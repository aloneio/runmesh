/** Scheduler admission limits. Defaults use half of each hard upper bound.
 * Keep these independent of the Runner transport and CLI configuration. */
export const MAX_CONCURRENT_JOBS = 64;
export const DEFAULT_MAX_CONCURRENT_JOBS = MAX_CONCURRENT_JOBS / 2;
export const MAX_QUEUED_JOBS = 1_000;
export const DEFAULT_MAX_QUEUED_JOBS = MAX_QUEUED_JOBS / 2;
export const MAX_QUEUED_JOBS_PER_CLIENT = MAX_QUEUED_JOBS;
export const DEFAULT_MAX_QUEUED_JOBS_PER_CLIENT = MAX_QUEUED_JOBS_PER_CLIENT / 2;
