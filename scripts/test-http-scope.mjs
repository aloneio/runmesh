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
