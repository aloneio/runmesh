import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

const MAX_REQUESTS = 8_192, MAX_SOCKETS = 2_048, MAX_ERRORS = 64;
const MAX_DURATION = 900_000, MAX_BYTES = 2_147_483_647;
const weakKey = value => value !== null && (typeof value === "object" || typeof value === "function");
const elapsed = (start, now) => Number.isFinite(start) && Number.isFinite(now)
  ? Math.min(MAX_DURATION, Math.max(0, Math.floor(now - start))) : 0;
function counter(socket, name) {
  try { const value = socket?.[name]; return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  catch { return null; }
}
const boundedBytes = value => value === null ? null : Math.min(MAX_BYTES, value);
const deltaBytes = (value, start) => value === null || start === null || value < start ? null : boundedBytes(value - start);
function destroyed(socket) {
  try { const value = socket?.destroyed; return typeof value === "boolean" ? value : null; }
  catch { return null; }
}

/** Observe only this fixture's HTTP origin. This does not dispatch or alter requests.
 * Counts cover this observation window, including the failing send. A first-seen
 * socket is of unknown age unless its matching client:connected event was seen. */
export function createFixtureTransportObserver(origin) {
  let url;
  try { url = new URL(origin); } catch { throw new TypeError("Invalid fixture transport origin"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Invalid fixture transport origin");
  }
  const target = url.origin, port = url.port;
  let closed = false, requestSequence = 0, socketSequence = 0, errorCount = 0;
  let requests = new WeakMap(), sockets = new WeakMap(), errors = new WeakMap();
  const subscriptions = [];
  const matches = value => typeof value === "string" ? value === target : value instanceof URL && value.origin === target;
  function socketState(socket, connected = false) {
    if (!weakKey(socket)) return undefined;
    let state = sockets.get(socket);
    if (state === undefined && socketSequence < MAX_SOCKETS) {
      state = { sequence: ++socketSequence, count: 0, active: 0, completedAt: null, connected };
      sockets.set(socket, state);
    }
    return state;
  }
  function release(state, completed) {
    if (!state.active) return;
    state.active = false;
    const socket = state.socketState;
    if (socket !== undefined) {
      socket.active = Math.max(0, socket.active - 1);
      socket.completedAt = completed && socket.active === 0 ? performance.now() : null;
    }
  }
  function subscribe(name, observe) {
    const listener = value => {
      if (closed) return;
      try { observe(value); } catch { /* Observations never change request behavior. */ }
    };
    try { const event = channel(name); event.subscribe(listener); subscriptions.push([event, listener]); }
    catch { /* An unavailable observation channel cannot affect the fixture. */ }
  }

  subscribe("undici:client:connected", ({ connectParams, socket }) => {
    if (connectParams?.protocol === "http:" && connectParams.hostname === "127.0.0.1"
      && (typeof connectParams.port === "string" || typeof connectParams.port === "number")
      && String(connectParams.port) === port) socketState(socket, true);
  });
  subscribe("undici:request:create", ({ request }) => {
    if (!weakKey(request) || requests.has(request) || !matches(request.origin) || requestSequence >= MAX_REQUESTS) return;
    requests.set(request, { sequence: ++requestSequence, createdAt: performance.now(), headers: false,
      active: false, socket: undefined, socketState: undefined, socketCount: null, reused: null,
      idle: null, bytesRead: null, bytesWritten: null, failure: undefined });
  });
  subscribe("undici:client:sendHeaders", ({ request, socket }) => {
    const state = weakKey(request) ? requests.get(request) : undefined;
    if (state === undefined || state.failure !== undefined) return;
    if (state.active) {
      // An additional send before completion has no established idle boundary.
      if (state.socketState !== undefined) state.socketState.completedAt = null;
      release(state, false);
    }
    const observedSocket = socketState(socket);
    state.socket = weakKey(socket) ? new WeakRef(socket) : undefined;
    state.socketState = observedSocket;
    state.socketCount = null; state.reused = null; state.idle = null;
    state.bytesRead = counter(socket, "bytesRead"); state.bytesWritten = counter(socket, "bytesWritten");
    if (observedSocket === undefined) return;
    state.reused = observedSocket.count > 0 ? true : observedSocket.connected ? false : null;
    state.idle = observedSocket.completedAt !== null && observedSocket.active === 0
      ? elapsed(observedSocket.completedAt, performance.now()) : null;
    observedSocket.completedAt = null;
    // Preserve an exact count within the bounded window; overflow is unknown.
    observedSocket.count = Math.min(MAX_REQUESTS + 1, observedSocket.count + 1);
    state.socketCount = observedSocket.count <= MAX_REQUESTS ? observedSocket.count : null;
    observedSocket.active++;
    state.active = true;
  });
  subscribe("undici:request:headers", ({ request }) => {
    const state = weakKey(request) ? requests.get(request) : undefined;
    if (state !== undefined && state.failure === undefined) state.headers = true;
  });
  subscribe("undici:request:trailers", ({ request }) => {
    const state = weakKey(request) ? requests.get(request) : undefined;
    if (state !== undefined) release(state, true);
  });
  subscribe("undici:request:error", ({ request, error }) => {
    const state = weakKey(request) ? requests.get(request) : undefined;
    if (state === undefined) return;
    if (state.failure === undefined) {
      const socket = state.socket?.deref(), read = counter(socket, "bytesRead"), written = counter(socket, "bytesWritten");
      state.failure = Object.freeze({
        request_sequence: state.sequence,
        socket_sequence: state.socketState?.sequence ?? null,
        socket_request_count: state.socketCount,
        reused: state.reused, idle_ms: state.idle,
        request_elapsed_ms: elapsed(state.createdAt, performance.now()),
        headers_received: state.headers, socket_destroyed: destroyed(socket),
        socket_bytes_read: boundedBytes(read), socket_bytes_written: boundedBytes(written),
        socket_bytes_read_delta: deltaBytes(read, state.bytesRead),
        socket_bytes_written_delta: deltaBytes(written, state.bytesWritten),
      });
    }
    if (weakKey(error)) {
      if (errors.has(error)) {
        // A shared cancellation reason cannot identify an individual request.
        if (errors.get(error) !== state.failure) errors.set(error, null);
      } else if (errorCount < MAX_ERRORS) {
        errors.set(error, state.failure); errorCount++;
      }
    }
    release(state, false);
  });

  return {
    failure(error) {
      if (closed) return undefined;
      try {
        const seen = new Set();
        for (let depth = 0; depth < 8 && weakKey(error) && !seen.has(error); depth++) {
          const record = errors.get(error);
          if (record === null) return undefined;
          if (record !== undefined) return record;
          seen.add(error); error = error.cause;
        }
      } catch { /* Error accessors are outside the observation contract. */ }
      return undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [event, listener] of subscriptions) {
        try { event.unsubscribe(listener); } catch { /* A remaining listener is inert. */ }
      }
      subscriptions.length = 0;
      requests = new WeakMap(); sockets = new WeakMap(); errors = new WeakMap();
    },
  };
}
