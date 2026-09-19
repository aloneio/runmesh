import type { EnrollCliDependencies } from "./contracts.js";
import { enrollRunner } from "../enrollment.js";
import type { ExecutionMode } from "../service.js";
import { isEnrollmentOutcomeUnknown } from "../enrollment.js";
import type { ParsedCommand } from "./contracts.js";
import { parseProductArgs } from "./input.js";
import { ProfileStore } from "../profile.js";
import { report } from "./reporting.js";
import { requiredString } from "./input.js";
import type { RunnerProfile } from "../profile.js";
import { storeFor } from "./input.js";

/**
 * Read a one-time enrollment code without placing it in argv, a URL, or the
 * shell command history. The first line is sufficient; EOF is also accepted
 * for pipe-based installers. A caller can inject the source for tests and for
 * hosts that provide a secret-input prompt of their own.
 */
export async function enrollmentCode(parsed: ParsedCommand, readStdin?: () => Promise<string>): Promise<string> {
  const fromArgument = typeof parsed.values.code === "string" ? parsed.values.code : undefined;
  if (parsed.values.codeStdin === true && fromArgument !== undefined) throw new Error("--code and --code-stdin cannot be used together");
  if (parsed.values.codeStdin !== true) return requiredString(parsed, "code");
  const source = readStdin ?? readEnrollmentStdin;
  const code = (await source()).trim();
  if (code.length === 0) throw new Error("--code-stdin requires a one-time enrollment code");
  return code;
}

function readEnrollmentStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdin.removeListener("end", onEnd);
      if (error === undefined) resolve(value); else reject(error);
    };
    // Enrollment is entered one line at a time in the manual flow. Resolving
    // on the first newline keeps `--code-stdin` usable from a TTY (Enter is a
    // natural completion signal) while still accepting a normal pipe, whose
    // EOF path remains supported for hosted installers.
    const onData = (chunk: string | Buffer): void => {
      value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (value.length > 512) { finish(new Error("--code-stdin input is too long")); return; }
      const lineEnd = value.search(/[\r\n]/u);
      if (lineEnd >= 0) { value = value.slice(0, lineEnd); finish(); }
    };
    const onError = (): void => finish(new Error("--code-stdin input could not be read"));
    const onEnd = (): void => finish();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("error", onError);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

/**
 * Remove a profile only when it is still the profile observed by this
 * enrollment attempt.  A second CLI process may have completed a newer
 * enrollment while the first process was handling an uncertain response;
 * unconditional rm() would otherwise delete that valid credential.
 *
 * This is deliberately a best-effort compare-before-remove.  ProfileStore has
 * no portable atomic compare-and-delete primitive, so callers should still
 * serialize enrollment operations when strict cross-process exclusion is
 * required.  The identity check closes the common late-cleanup race without
 * changing ProfileStore's on-disk format.
 */
export async function removeEnrollmentProfileIfCurrent(store: ProfileStore, expected: RunnerProfile | undefined): Promise<boolean> {
  // An absent pre-enrollment snapshot is not an ownership proof.  There is no
  // portable compare-and-delete primitive here, so loading `undefined` and
  // then removing can race a concurrent enrollment that creates a profile
  // between those two operations.  Leave the profile untouched unless this
  // invocation can name the exact validated snapshot it wrote.
  if (expected === undefined) return false;
  try {
    const current = await store.load();
    if (!sameEnrollmentProfile(current, expected)) return false;
    await store.remove();
    return true;
  } catch {
    return false;
  }
}

export function sameEnrollmentProfile(left: RunnerProfile | undefined, right: RunnerProfile): boolean {
  // Compare the complete validated snapshot, not merely credential identity:
  // a concurrent workspace-policy update must not be discarded by cleanup.
  // ProfileStore normalizes object-key order while `enrollRunner` constructs
  // its result in a different order, so a raw JSON.stringify comparison would
  // incorrectly skip cleanup after a post-enrollment failure.
  return left !== undefined
    && left.version === right.version
    && left.server_url === right.server_url
    && left.runner_id === right.runner_id
    && left.token === right.token
    && left.insecure_local === right.insecure_local
    && left.management_mode === right.management_mode
    && left.execution_mode === right.execution_mode
    && left.max_concurrent_jobs === right.max_concurrent_jobs
    && left.workspaces.length === right.workspaces.length
    && left.workspaces.every((workspace, index) => {
      const other = right.workspaces[index];
      return other !== undefined
        && workspace.id === other.id
        && workspace.path === other.path
        && workspace.writable === other.writable
        && workspace.shell === other.shell;
    });
}

export function enrollmentFailureMessage(detail: string, credentialsConsumed: boolean, outcomeUnknown: boolean, profileRemoved: boolean): string {
  if (!credentialsConsumed && !outcomeUnknown) return detail;
  const cleanup = profileRemoved
    ? "the local profile was removed"
    : "the local profile could not be removed; do not use the existing profile until its credential is verified";
  if (credentialsConsumed) return `${detail}; enrollment credentials were consumed and ${cleanup}; generate a new enrollment code and retry`;
  return `${detail}; ${cleanup} because the enrollment outcome is unknown; generate a new enrollment code and retry`;
}

export async function runEnrollCli(argv: readonly string[], dependencies: EnrollCliDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseProductArgs(["enroll", ...argv]);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  let previousProfile: RunnerProfile | undefined;
  let enrolled = false;
  let enrolledProfile: RunnerProfile | undefined;
  try {
    const server = requiredString(parsed, "server");
    const code = await enrollmentCode(parsed, dependencies.readStdin);
    previousProfile = await store.load();
    const result = await enrollRunner({
      server, code, reEnroll: parsed.values.reEnroll === true, insecureLocal: parsed.values.insecureLocal === true,
      ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : dependencies.executionMode === undefined ? {} : { executionMode: dependencies.executionMode }),
      ...(parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}),
      ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}),
      ...(dependencies.store === undefined ? { store } : { store: dependencies.store }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
    enrolled = true;
    enrolledProfile = result.profile;
    if (dependencies.afterEnroll !== undefined) await dependencies.afterEnroll();
    report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const outcomeUnknown = isEnrollmentOutcomeUnknown(cause);
    const profileRemoved = enrolled || outcomeUnknown
      ? await removeEnrollmentProfileIfCurrent(store, enrolledProfile ?? previousProfile)
      : false;
    error(enrollmentFailureMessage(detail, enrolled, outcomeUnknown, profileRemoved));
    throw cause;
  }
}
