import type { InspectResultKind } from "../contracts.js";
import type { RunnerResultMode } from "../contracts.js";
import { safeContextResult } from "./context.js";
import { safeEditResult } from "./files.js";
import { safeInspectResult } from "./files.js";
import { safeJobInputResult } from "./jobs.js";
import { safeJobLogResult } from "./jobs.js";
import { safeJobMetadata } from "./jobs.js";
import { safeReadResult } from "./files.js";
import { safeShellResult } from "./jobs.js";

export function inspectResultMode(action: InspectResultKind): RunnerResultMode { return `inspect:${action}` as RunnerResultMode; }

export function projectRunnerResult(value: unknown, mode: RunnerResultMode): unknown {
  if (mode === "job") return safeJobMetadata(value);
  if (mode === "logs") return safeJobLogResult(value);
  if (mode === "input") return safeJobInputResult(value);
  if (mode === "shell") return safeShellResult(value);
  if (mode === "read") return safeReadResult(value);
  if (mode === "edit") return safeEditResult(value);
  if (mode === "context") return safeContextResult(value);
  if (mode.startsWith("inspect:")) return safeInspectResult(value, mode.slice("inspect:".length) as InspectResultKind);
  return value;
}
