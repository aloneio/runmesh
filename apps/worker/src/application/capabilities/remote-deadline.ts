import { REMOTE_LIMITS } from "../../contracts/remote.js";

/** A bounded observation. Aborting cancels local I/O, not remote side effects. */
export async function remoteDeadline<T>(parent: AbortSignal, timedOut: () => T,
  action: (signal: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
  if (parent.aborted) return timedOut();
  const controller = new AbortController(), end = performance.now() + REMOTE_LIMITS.operation_ms;
  let timer: ReturnType<typeof setTimeout> | undefined, stop = () => undefined;
  const deadline = new Promise<T>(resolve => {
    stop = () => { controller.abort(); resolve(timedOut()); };
    parent.addEventListener("abort", stop, { once: true }); timer = setTimeout(stop, REMOTE_LIMITS.operation_ms);
  });
  try { return await Promise.race([action(controller.signal, () => controller.signal.aborted || performance.now() >= end), deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); parent.removeEventListener("abort", stop); controller.abort(); }
}
