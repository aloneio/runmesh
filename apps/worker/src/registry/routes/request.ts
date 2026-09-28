import type { InternalInput } from "../records.js";
import type { RunnerRouteRequest } from "../route-inputs.js";

/** Already admitted by RegistryDO. Route adapters must remain synchronous. */
export interface RegistryRouteRequest {
  method: string;
  segments: string[];
  input: InternalInput;
  nowMs: number;
  url: URL;
}
export type RegistryRoute = (request: RegistryRouteRequest) => Response | undefined;

export type RunnerRoute = (request: RunnerRouteRequest) => Response | undefined;
