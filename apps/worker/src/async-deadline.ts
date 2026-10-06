/** Request-local scheduling only. Callers own their budget and timeout outcome;
 * aborting local work does not establish whether a remote mutation completed. */
export async function asyncDeadline<T>(parent: AbortSignal, durationMs: number, onTimeout: () => T,
  operation: (signal: AbortSignal, expired: () => boolean) => Promise<T>): Promise<T> {
  if (parent.aborted) return onTimeout();
  const controller = new AbortController(), signal = controller.signal;
  const end = performance.now() + durationMs;
  const expired = () => signal.aborted || performance.now() >= end;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => undefined, stopping = false;
  const stopped = new Promise<T>((resolve, reject) => {
    abort = () => {
      if (stopping) return;
      stopping = true; controller.abort();
      try { resolve(onTimeout()); } catch (error) { reject(error); }
    };
    parent.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, durationMs);
  });
  try {
    // Preserve the operation promise and its timing while capturing a throw
    // after parent cancellation, so both rejections enter the same race.
    let running: Promise<T>;
    try { running = operation(signal, expired); } catch (error) { running = Promise.reject(error); }
    return await Promise.race([running, stopped]);
  }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", abort); controller.abort();
  }
}
