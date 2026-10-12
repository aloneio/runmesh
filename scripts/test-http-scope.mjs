import { AsyncLocalStorage } from "node:async_hooks";

/** Bind HTTP work to its test, including continuations that outlive a timeout.
 * Fixture setup outside a test keeps the caller's own request lifetime. */
export function createTestHttpScope(fetchImpl = globalThis.fetch) {
  const current = new AsyncLocalStorage();
  return {
    run(signal, action) {
      const controller = new AbortController();
      const lifetime = AbortSignal.any([signal, controller.signal]);
      return current.run(lifetime, async () => {
        try { return await action(); }
        finally { controller.abort(); }
      });
    },
    async fetch(input, init) {
      const lifetime = current.getStore();
      if (lifetime === undefined) return fetchImpl(input, init);
      lifetime.throwIfAborted();
      const caller = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
      return fetchImpl(input, { ...init, signal: caller ? AbortSignal.any([lifetime, caller]) : lifetime });
    },
  };
}

/** Run one bounded test load; its first failure cancels and joins admitted work.
 * Callers pass the supplied signal to scoped fetches, retaining the test deadline.
 * @param {{ count: number, concurrency: number, run: (index: number, signal: AbortSignal) => void | Promise<void>, onFirstFailure?: (error: unknown) => void | Promise<void> }} options
 */
export async function runBoundedConcurrentLoad({ count, concurrency, run, onFirstFailure }) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 128
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("Test load exceeds its bounded request or concurrency limit");
  const controller = new AbortController();
  let next = 0, failed = false, firstFailure;
  await Promise.allSettled(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (!failed && next < count) {
      const index = next++;
      try { await run(index, controller.signal); }
      catch (error) {
        if (!failed) {
          failed = true; firstFailure = error;
          // Freeze evidence before cancellation changes pending-request counts.
          // Observer failures cannot replace the initiating error or delay abort.
          try { void Promise.resolve(onFirstFailure?.(error)).catch(() => undefined); }
          catch { /* A diagnostic observer does not own the load's outcome. */ }
          controller.abort();
        }
      }
    }
  }));
  if (failed) throw firstFailure;
}
