import { REMOTE_LIMITS } from "../../contracts/remote.js";
import { asyncDeadline } from "../../async-deadline.js";

/** A bounded observation. Aborting cancels local I/O, not remote side effects. */
export async function remoteDeadline<T>(parent: AbortSignal, timedOut: () => T,
  action: (signal: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
  return asyncDeadline(parent, REMOTE_LIMITS.operation_ms, timedOut, action);
}
