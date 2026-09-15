import type { CodingScope } from "../contracts/administration.js";
import type { ConsoleExecutionMode } from "../contracts/runner-admin.js";
import { DAY_MS } from "../domain/execution-mode.js";
import { DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from "../contracts/enrollment-options.js";
import type { EnrollmentWindow } from "../contracts/runner-admin.js";
import type { ExecutionModeSelection } from "../contracts/runner-admin.js";
import { MAX_VALIDITY_DAYS } from "../domain/execution-mode.js";
import { RUNNER_ENROLLMENT_TTL_OPTIONS_MS } from "../contracts/enrollment-options.js";
import { runnerConfiguredExecutionMode } from "../domain/execution-mode.js";
import type { ValidityWindow } from "../validity.js";

function formDays(form: FormData, name: string): number | null | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (value === "") return null;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const days = Number(value);
  return Number.isSafeInteger(days) && days <= MAX_VALIDITY_DAYS ? days : undefined;
}

export function runnerWindowFromForm(form: FormData): ValidityWindow | undefined {
  if (!form.has("runner_valid_days")) return { valid_from_ms: null, valid_until_ms: null };
  const days = formDays(form, "runner_valid_days");
  if (days === undefined) return undefined;
  return { valid_from_ms: null, valid_until_ms: days === null || days === 0 ? null : Date.now() + days * DAY_MS };
}

export function enrollmentWindowFromForm(form: FormData): EnrollmentWindow | undefined {
  if (!form.has("code_valid_days")) return {};
  const days = formDays(form, "code_valid_days");
  if (days === undefined) return undefined;
  return days === null || days < 1 ? undefined : { expires_at_ms: Date.now() + days * DAY_MS };
}

export function formEnrollmentTtl(form: FormData): number | undefined {
  const value = form.get("enrollment_ttl_ms");
  if (value === null || value === "") return DEFAULT_RUNNER_ENROLLMENT_TTL_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (RUNNER_ENROLLMENT_TTL_OPTIONS_MS as readonly number[]).includes(parsed) ? parsed : undefined;
}

/**
 * Parse a fresh administrator service-mode choice at the authenticated form
 * boundary. New Runner records must always carry an explicit mode.
 */
export function executionModeFromForm(form: FormData): ExecutionModeSelection | undefined {
  const raw = form.get("execution_mode");
  let mode: ConsoleExecutionMode;
  if (raw === "dedicated_user" || raw === "privileged_host") mode = raw;
  else return undefined;
  const confirmed = form.getAll("confirm_privileged_host").some((value) => value === "true");
  if (mode === "privileged_host" && !confirmed) return undefined;
  return { mode, confirmed: mode === "privileged_host" && confirmed };
}

/**
 * Resolve an action form against the server-owned Registry choice. The
 * execution mode is configuration, not Runner-authored telemetry. Reusing an existing privileged choice is
 * intentional—the administrator already acknowledged that high-risk mode at
 * installation/migration—so credential rotation and code regeneration do not
 * become a second privilege prompt.  A fresh transition to privileged_host
 * still requires the acknowledgement in the submitted form.
 */
export function executionModeForExistingRunner(form: FormData, runner: { readonly configured_execution_mode?: unknown; readonly metadata?: unknown; readonly public_info?: unknown }): ExecutionModeSelection | undefined {
  const configured = runnerConfiguredExecutionMode(runner);
  const raw = form.get("execution_mode");
  const confirmed = form.getAll("confirm_privileged_host").some((value) => value === "true");
  const expectedRaw = form.get("expected_execution_mode");
  const expected = expectedRaw === "" ? null
    : expectedRaw === "dedicated_user" || expectedRaw === "privileged_host" ? expectedRaw
      : expectedRaw === null ? "missing" : "invalid";
  if (expected === "invalid" || expected === "missing" || expected !== configured) return undefined;
  if (raw === null) {
    return configured === null ? undefined : { mode: configured, confirmed: configured === "privileged_host" };
  }
  if (raw !== "dedicated_user" && raw !== "privileged_host") return undefined;
  if (raw === "privileged_host" && !confirmed && configured !== "privileged_host") return undefined;
  return { mode: raw, confirmed: raw === "privileged_host" };
}

export function configuredWorkspacePreset(value: FormDataEntryValue | null): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  if (value === "read_only") return { read: true, edit: false, shell: false, job_control: false };
  if (value === "edit_only") return { read: true, edit: true, shell: false, job_control: false };
  if (value === "controlled_exec" || value === "coding") return { read: true, edit: true, shell: true, job_control: true };
  if (value === "custom" || value === null) return undefined;
  return undefined;
}

export function permissionsFromForm(form: FormData): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  const value = (name: string): boolean | undefined => { const entry = form.get(name); return entry === "true" ? true : entry === "false" ? false : undefined; };
  const read = value("read"); const edit = value("edit"); const shell = value("shell"); const jobControl = value("job_control");
  return read === undefined || edit === undefined || shell === undefined || jobControl === undefined ? undefined : { read, edit, shell, job_control: jobControl };
}

export function isAbsolutePath(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)); }

export function selectedScopes(form: FormData): CodingScope[] | undefined { const values = form.getAll("scopes"); const scopes = values.filter((value): value is CodingScope => value === "coding:read" || value === "coding:write" || value === "coding:exec"); return scopes.length === values.length && scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : undefined; }

export function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1_024; }

export function validLabel(label: string): boolean { return label.trim().length > 0 && label.length <= 256; }

export function validRunnerVersion(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }
