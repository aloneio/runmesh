import { normalizeJobRecord } from "../../apps/runner/src/jobs/records.js";
import { retainedJobCandidates, expiredRetainedJob } from "../../apps/runner/src/jobs/retention-plan.js";
import { jobEventMessage } from "../../apps/runner/src/connection/job-events.js";
import { expect, it } from "vitest";
import { historyCleanupDue, nextMaintenanceDeadline } from "../../apps/worker/src/registry/maintenance-plan.js";
import { summarizeFeatureError } from "../../apps/worker/src/registry/feature-health-model.js";
import { availableLogBytes } from "../../apps/runner/src/jobs/log-budget.js";

it("maintenance only schedules a bounded deadline for valid observations", () => {
  expect(nextMaintenanceDeadline(10000, undefined, null)).toBeNull();
  expect(nextMaintenanceDeadline(10000, -1, Number.NaN)).toBeNull();
  expect(nextMaintenanceDeadline(10000, 10500, 50000)).toBe(11000);
  expect(nextMaintenanceDeadline(10000, 50000, 20000)).toBe(20000);
});
it("cleanup validates persisted deadlines and retains the exact expiry boundary", () => {
  for (const next of [undefined, null, -1, Number.NaN, 9999, 10000, 20001]) expect(historyCleanupDue(next,10000,10000)).toBe(true);
  for (const next of [10001, 20000]) expect(historyCleanupDue(next,10000,10000)).toBe(false);
});
it("feature errors remain bounded and unserializable values get the existing fallback", () => {
  expect(summarizeFeatureError(new Error("quota"))).toBe("Error: quota");
  expect(summarizeFeatureError("x".repeat(500))).toHaveLength(240);
  expect(summarizeFeatureError(undefined)).toBe("feature write failed");
  const circular: { self?: unknown } = {}; circular.self=circular;
  expect(summarizeFeatureError(circular)).toBe("feature write failed");
});
it("log capacity obeys both budgets including already over-budget observations", () => {
  for(const job of [0,2,10,20]) for(const total of [0,5,20,30]) {
    const capacity=availableLogBytes(job,total,10,20);
    expect(capacity).toBe(Math.max(0,Math.min(10-job,20-total)));
    expect(capacity).toBeGreaterThanOrEqual(0);
  }
  expect(availableLogBytes(0,20,10,20)).toBe(0);
});

it("retention preserves active and recovered-live jobs, original identities and deterministic ordering", () => {
  const states = ["queued","running","cancelling","cancelled","succeeded","failed","unknown","interrupted"] as const;
  const jobs=states.map((status,i)=>{
    const record=normalizeJobRecord({job_id:`job-00000000-0000-0000-0000-${String(i).padStart(12,"0")}`,workspace_id:"w",cwd:".",command:["synthetic"],shell:false,status,created_at_ms:100,updated_at_ms:200});
    if(record===undefined)throw new Error("invalid fixture");return record;
  });
  const protectedId=jobs[4]!.job_id;
  const candidates=retainedJobCandidates(jobs,new Set([protectedId]));
  expect(candidates.map(j=>j.status)).toEqual(["cancelled","failed","interrupted"]);
  for(const job of candidates)expect(jobs.find(j=>j.job_id===job.job_id)).toBe(job);
  expect(jobs.map(j=>j.status)).toEqual(states);
  for(const job of jobs)expect(expiredRetainedJob(job,200)).toBe(["cancelled","succeeded","failed","interrupted"].includes(job.status));
  expect(expiredRetainedJob({...jobs[4]!,completed_at_ms:250},249)).toBe(false);
  expect(expiredRetainedJob({...jobs[4]!,completed_at_ms:250},250)).toBe(true);
});
it("legacy Job frame projection preserves metadata and does not turn output or unknown completion into an event",()=>{
  const job=normalizeJobRecord({job_id:"job-00000000-0000-0000-0000-000000000001",workspace_id:"w",cwd:".",command:["PRIVATE_COMMAND"],shell:false,status:"succeeded",created_at_ms:100,updated_at_ms:200,completed_at_ms:200,exit_code:0,created_by_client_id:"c",request_id:"r"});
  if(job===undefined)throw new Error("invalid fixture");
  const message=jobEventMessage({type:"completed",job},"runner");
  expect(message).toMatchObject({type:"job.completed",completed_at_ms:200,outcome:"succeeded",exit_code:0,job:{runner_id:"runner",created_by_client_id:"c",request_id:"r"}});
  expect(JSON.stringify(message)).not.toContain("PRIVATE_COMMAND");
  expect(jobEventMessage({type:"started",job},"runner")).toMatchObject({type:"job.started",started_at_ms:200});
  expect(jobEventMessage({type:"status",job},"runner")).toMatchObject({type:"job.status"});
  expect(jobEventMessage({type:"output",job},"runner")).toBeUndefined();
  expect(jobEventMessage({type:"completed",job:{...job,status:"unknown"}},"runner")).toBeUndefined();
});
