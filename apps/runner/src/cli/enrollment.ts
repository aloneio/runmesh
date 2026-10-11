import type { EnrollCliDependencies } from "./contracts.js";
import { enrollRunner } from "../enrollment.js";
import type { ExecutionMode } from "../service.js";
import { isEnrollmentOutcomeUnknown } from "../enrollment.js";
import type { ParsedCommand } from "./contracts.js";
import { parseProductArgs } from "./input.js";
import { ProfileStore } from "../profile.js";
import { markCliErrorReported, report } from "./reporting.js";
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

export type EnrollmentProfileCleanup = "absent" | "removed" | "changed" | "failed";

/**
 * Remove a profile only when it is still the profile observed by this
 * enrollment attempt.  A second CLI process may have completed a newer
 * enrollment while the first process was handling an uncertain response;
 * unconditional rm() would otherwise delete that valid credential.
 *
 * The enrollment lease stays held through the comparison and removal. The
 * snapshot check also preserves changes made by other profile writers.
 */
export async function removeEnrollmentProfileIfCurrent(store: ProfileStore, expected: readonly RunnerProfile[], assertHeld: () => void): Promise<EnrollmentProfileCleanup> {
  try {
    const current = await store.load();
    assertHeld();
    if (current === undefined) return "absent";
    // An absent pre-enrollment snapshot is not an ownership proof.  The read
    // above is only for reporting; never remove a profile this invocation did
    // not observe, including one created after a stale read reported absence.
    if (!expected.some(profile => sameEnrollmentProfile(current, profile))) return "changed";
    await store.remove();
    return "removed";
  } catch {
    return "failed";
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

export function enrollmentFailureMessage(detail: string, credentialsConsumed: boolean, outcomeUnknown: boolean, profileCleanup?: EnrollmentProfileCleanup): string {
  if (!credentialsConsumed && !outcomeUnknown) return detail;
  if (credentialsConsumed && !outcomeUnknown && profileCleanup === undefined) {
    return `${detail}; enrollment completed and the local profile was retained; resolve the local error before continuing setup`;
  }
  const cleanupMessages: Record<EnrollmentProfileCleanup, string> = {
    absent: "no local profile was found",
    removed: "the local profile was removed",
    changed: "the updated local profile was preserved",
    failed: "the local profile could not be removed; do not use the existing profile until its credential is verified",
  };
  const cleanup = profileCleanup === undefined ? "" : `${cleanupMessages[profileCleanup]}; `;
  const consumed = credentialsConsumed ? "enrollment credentials were consumed; " : "";
  return `${detail}; ${consumed}${cleanup}generate a new enrollment code and retry`;
}

export async function runEnrollCli(argv: readonly string[], dependencies: EnrollCliDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseProductArgs(["enroll", ...argv]);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  let enrolled = false;
  let profileCleanup: EnrollmentProfileCleanup | undefined;
  try {
    const server = requiredString(parsed, "server");
    const code = await enrollmentCode(parsed, dependencies.readStdin);
    const result = await enrollRunner({
      server, code, reEnroll: parsed.values.reEnroll === true, insecureLocal: parsed.values.insecureLocal === true,
      ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : dependencies.executionMode === undefined ? {} : { executionMode: dependencies.executionMode }),
      ...(parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}),
      ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}),
      ...(dependencies.store === undefined ? { store } : { store: dependencies.store }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      afterEnroll: async () => {
        enrolled = true;
        if (dependencies.afterEnroll !== undefined) await dependencies.afterEnroll();
      },
      onFailure: async (cause, attempt) => {
        enrolled = attempt.enrolled;
        if (enrolled || isEnrollmentOutcomeUnknown(cause)) {
          const expected = [attempt.previousProfile, attempt.attemptedProfile].filter((profile): profile is RunnerProfile => profile !== undefined);
          profileCleanup = await removeEnrollmentProfileIfCurrent(store, expected, attempt.assertHeld);
        }
      },
    });
    report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const outcomeUnknown = isEnrollmentOutcomeUnknown(cause);
    error(enrollmentFailureMessage(detail, enrolled, outcomeUnknown, profileCleanup));
    throw markCliErrorReported(cause);
  }
}
