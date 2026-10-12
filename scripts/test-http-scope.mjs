import { AsyncLocalStorage } from "node:async_hooks";

/** Bind HTTP work to its test, including continuations that outlive a timeout.
 * Fixture setup outside a test keeps the caller's own request lifetime. */
export function createTestHttpScope(fetchImpl = globalThis.fetch, { cleanupTimeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30_000) throw new RangeError("Test cleanup must fit the existing hook deadline");
  const current = new AsyncLocalStorage();
  let poisoned;
  const cleanupState = root => {
    if (root.closed) throw new Error("Test HTTP scope has finished");
    if (root.cleanup === undefined) {
      const controller = new AbortController();
      let timer;
      const expired = new Promise(resolve => {
        timer = setTimeout(() => {
          const error = new Error("Test body cleanup exceeded its hook deadline");
          controller.abort(error);
          resolve(error);
        }, cleanupTimeoutMs);
      });
      root.cleanup = { controller, expired, timer };
    }
    return root.cleanup;
  };
  return {
    run(signal, action) {
      if (poisoned !== undefined) throw poisoned;
      const controller = new AbortController();
      const lifetime = AbortSignal.any([signal, controller.signal]);
      const root = { controller, pending: new Set(), cleanup: undefined, closed: false };
      return current.run({ root, lifetime }, async () => {
        try { return await action(); }
        finally {
          controller.abort();
          root.closed = true;
          root.cleanup?.controller.abort();
          clearTimeout(root.cleanup?.timer);
          // Vitest may stop awaiting afterEach at its own deadline. Quarantine
          // this shared fixture even when that external timeout wins the race.
          if (root.pending.size > 0) poisoned ??= new Error("Previous test body is still cleaning up; shared fixture is quarantined");
        }
      });
    },
    /** Retain the raw callback beneath Vitest's timeout/cancellation wrapper. */
    trackBody(action) {
      const state = current.getStore();
      if (state === undefined) throw new Error("Tracked test body requires an active HTTP scope");
      const { root, lifetime } = state;
      const pending = Promise.resolve().then(() => { lifetime.throwIfAborted(); return action(); });
      root.pending.add(pending);
      void pending.then(() => root.pending.delete(pending), () => root.pending.delete(pending));
      return pending;
    },
    /** Called by afterEach, before finished/failed hooks inspect the fixture. */
    async finish() {
      const root = current.getStore()?.root;
      if (root === undefined) return;
      root.controller.abort();
      if (root.pending.size === 0) return;
      const cleanup = cleanupState(root);
      const error = await Promise.race([
        Promise.allSettled([...root.pending]).then(() => undefined),
        cleanup.expired,
      ]);
      if (error !== undefined) { poisoned ??= error; throw error; }
    },
    /** Only explicit fixture restoration gets the existing hook's own lifetime.
     * Business continuations retain the cancelled lifetime through async context. */
    cleanup(action) {
      const state = current.getStore();
      if (state === undefined) throw new Error("Test cleanup requires an active HTTP scope");
      const lifetime = cleanupState(state.root).controller.signal;
      lifetime.throwIfAborted();
      return current.run({ root: state.root, lifetime }, action);
    },
    async fetch(input, init) {
      const lifetime = current.getStore()?.lifetime;
      if (lifetime === undefined) return fetchImpl(input, init);
      lifetime.throwIfAborted();
      const caller = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
      return fetchImpl(input, { ...init, signal: caller ? AbortSignal.any([lifetime, caller]) : lifetime });
    },
  };
}

/** Preserve Vitest's collection API while tracking complete callback bodies.
 * Function proxies retain arity and fixture destructuring for each/for rows.
 * @template {Function} T
 * @param {T} test
 * @param {ReturnType<typeof createTestHttpScope>} scope
 * @returns {T}
 */
export function trackTestBodies(test, scope) {
  const wrapBody = body => new Proxy(body, {
    apply(target, receiver, args) { return scope.trackBody(() => Reflect.apply(target, receiver, args)); },
    get(target, key, receiver) { return key === "toString" ? target.toString.bind(target) : Reflect.get(target, key, receiver); },
  });
  const wrapApi = target => new Proxy(target, {
    apply(api, receiver, args) {
      return Reflect.apply(api, receiver, args.map((value, index) => index > 0 && typeof value === "function" ? wrapBody(value) : value));
    },
    get(api, key, receiver) {
      const value = Reflect.get(api, key, receiver);
      if (["each", "for", "skipIf", "runIf", "extend"].includes(key)) return (...args) => wrapApi(Reflect.apply(value, api, args));
      if (["skip", "only", "concurrent", "sequential", "fails", "todo"].includes(key)) return wrapApi(value);
      return value;
    },
  });
  return wrapApi(test);
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
