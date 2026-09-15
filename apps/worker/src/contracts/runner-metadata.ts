import type { RunnerExecutionMode } from "./administration.js";

export interface RunnerPublicInfo {
  readonly platform: string;
  readonly architecture: string;
  readonly hostname: string;
  readonly runner_version: string;
  readonly protocol_version: number;
  readonly execution_mode?: RunnerExecutionMode;
  readonly service_identity?: string;
  readonly privilege_state?: "privileged" | "restricted" | "mismatch" | "unknown";
}
