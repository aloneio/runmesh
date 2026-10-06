import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";
import { asyncDeadline } from "../../async-deadline.js";

/** One request-local deadline; no recurring work survives the call. */
export async function withinDeadline<T>(parent: AbortSignal, timeout: () => T,
  operation: (signal: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
  return asyncDeadline(parent, CONNECTOR_LIMITS.operation_ms, timeout, operation);
}
