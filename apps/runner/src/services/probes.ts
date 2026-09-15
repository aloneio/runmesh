import type { NativeProbeKind } from "./contracts.js";
import type { ServiceCommandResult } from "./contracts.js";
import type { SystemdEnablementState } from "./contracts.js";

const SYSTEMD_ENABLEMENT_STATES: ReadonlySet<SystemdEnablementState> = new Set([
  "enabled", "enabled-runtime", "disabled", "static", "indirect", "generated", "transient", "masked", "masked-runtime", "alias", "linked", "linked-runtime", "bad", "not-found",
]);

export function systemdEnablementState(result: ServiceCommandResult): SystemdEnablementState | undefined {
  // `systemctl is-enabled` writes one bounded state token to stdout.  Ignore
  // arbitrary stderr text here: a warning/error mixed with a stale token must
  // not authorize a destructive disable operation.
  const token = (result.stdout ?? "").trim().split(/\s+/u)[0]?.toLowerCase();
  return token !== undefined && SYSTEMD_ENABLEMENT_STATES.has(token as SystemdEnablementState)
    ? token as SystemdEnablementState
    : undefined;
}

export function nativeProbeReliable(result: ServiceCommandResult, kind: NativeProbeKind, knownInactiveUnit = false): boolean {
  if (result.exitCode === 0) return true;
  if (result.exitCode === 126 || result.exitCode === 127 || result.exitCode === 255) return false;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (detail === "") return kind === "active" && (result.exitCode === 3 || (result.exitCode === 4 && knownInactiveUnit));
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return false;
  // These are the normal absent-service messages emitted by systemctl,
  // launchctl, and schtasks.  `systemctl is-enabled` commonly prints the
  // hyphenated `not-found` state, so accept both spellings. Localized variants
  // without these words remain conservative (unreliable) rather than being
  // treated as a clean absence.
  if (/(not[- ]found|not loaded|does not exist|no such (?:unit|service|task|process|file)|could not find|could not be found|cannot find|cannot be found|system cannot find)/iu.test(detail)) return true;
  // `systemctl is-enabled` returns exit 1 for a known, non-enabled unit and
  // emits one of these state names. They are reliable observations (and must
  // not block a first install or re-enable), unlike a failed D-Bus/tool query.
  if (kind === "enabled" && /^(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)\s*$/iu.test(detail)) return true;
  // `systemctl is-active --quiet` uses exit 3 for a known inactive unit and
  // intentionally emits no text. Other no-output failures remain unknown.
  if (kind === "active" && result.exitCode === 3 && detail === "") return true;
  return false;
}

/**
 * Interpret `systemctl is-enabled` as a registration probe.  Enablement is
 * not the same thing as presence: `disabled`, `masked`, `static`, `bad`, and
 * linked states all describe a unit that occupies the native service name.
 * Only the explicit `not-found` state is an absence.  Unknown/error output is
 * kept separate so callers can fail closed instead of overwriting it.
 */
export function systemdRegistrationState(result: ServiceCommandResult): boolean | undefined {
  const output = (result.stdout ?? "").trim().toLowerCase();
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  // A diagnostic that mixes an ordinary state token with a transport or
  // permission failure is still an unknown probe.  Never let stale stdout
  // such as `not-found` turn a failed D-Bus query into permission to take over
  // a native registration.
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return undefined;
  const state = systemdEnablementState(result);
  if (state === "not-found" || /(?:^|\s)not[- ]found(?:\s|$)/iu.test(output) || /(?:^|\s)not[- ]found(?:\s|$)/iu.test(detail)) return false;
  if (result.exitCode === 0) return true;
  if (state !== undefined) return true;
  if (/(?:^|\s)(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)(?:\s|$)/iu.test(output)) return true;
  // A few systemd versions put the ordinary state in stderr. Keep the same
  // bounded token check there, but never classify permission/tool diagnostics
  // as a registration.
  if (/(?:^|\s)(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)(?:\s|$)/iu.test(detail)) return true;
  if (nativeProbeReliable(result, "enabled")) return false;
  return undefined;
}

/** Whether a non-zero systemd probe gives an explicit ordinary state. */
export function knownNonActiveUnit(result: ServiceCommandResult): boolean {
  if (result.exitCode === 0) return false;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (detail === "") return false;
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return false;
  return /(not[- ]found|not loaded|does not exist|no such (?:unit|service|task|process|file)|could not find|could not be found|cannot find|cannot be found|system cannot find|^(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)\s*$)/iu.test(detail);
}
