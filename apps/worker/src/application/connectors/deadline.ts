import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";

/** One request-local deadline; no recurring work survives the call. */
export async function withinDeadline<T>(parent: AbortSignal, timeout: () => T,
  operation: (signal: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
  if (parent.aborted) return timeout();
  const controller = new AbortController(), signal = controller.signal;
  const end = performance.now() + CONNECTOR_LIMITS.operation_ms;
  const expired = () => signal.aborted || performance.now() >= end;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => undefined;
  const stopped = new Promise<T>(resolve => {
    abort = () => { controller.abort(); resolve(timeout()); };
    parent.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, CONNECTOR_LIMITS.operation_ms);
  });
  try { return await Promise.race([operation(signal, expired), stopped]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", abort); controller.abort();
  }
}
