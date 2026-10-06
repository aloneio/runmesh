// A single navigation observation. URLs and request IDs only match local CDP
// events; the retained failure record contains fixed labels and bounded counts.
const phases = ["not_started", "headers_pending", "body_pending", "complete", "failed"];
const locales = ["en", "zh-CN"];
const requestTypes = ["fetch", "document", "other"];
const marker = "RUNMESH_E2E_UI_NAVIGATION_DIAGNOSTIC=";
const elapsedLimit = 600000, exceptionLimit = 1000;
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599;
const count = (value, limit) => Number.isInteger(value) && value >= 0 && value <= limit;
const requestType = value => value === "Fetch" ? "fetch" : value === "Document" ? "document" : "other";

/** Failure-only, independent HTTP observations; never replace the browser result. */
export async function probeUiNavigationServer(origin, cookie, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const base = new URL(origin);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password) throw new Error("UI server probe requires a local fixture");
  const observe = async (path, authenticated) => {
    const controller = new AbortController();
    let timer;
    const request = async () => {
      try {
        const response = await fetchImpl(new URL(path, base), { redirect: "manual", signal: controller.signal,
          headers: authenticated ? { cookie } : {} });
        void response.body?.cancel().catch(() => undefined);
        return { state: "response", status: statusCode(response.status) ? response.status : null };
      } catch { return { state: controller.signal.aborted ? "timeout" : "network_error", status: null }; }
    };
    try {
      return await Promise.race([request(), new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ state: "timeout", status: null }); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); controller.abort(); }
  };
  const [health, clients] = await Promise.all([observe("/health", false), observe("/admin/clients", true)]);
  return { health, clients };
}

function serverProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ["health", "clients"]) {
    const item = value[key];
    if (!item || !["response", "timeout", "network_error"].includes(item.state)
      || (item.state === "response" ? !statusCode(item.status) : item.status !== null)) return undefined;
    result[key] = { state: item.state, status: item.status };
  }
  return result;
}

export function createUiNavigationDiagnostic({ now = Date.now } = {}) {
  let active;
  return {
    begin(url, locale, sessionId) {
      active = { url, locale, sessionId, started: now(), exceptions: 0, requests: 0, redirects: 0, navigationErrors: 0 };
    },
    observe(message) {
      if (!active || message.sessionId !== active.sessionId) return;
      const event = message.params;
      if (message.method === "Runtime.exceptionThrown") active.exceptions = Math.min(exceptionLimit, active.exceptions + 1);
      if (message.method === "Runtime.consoleAPICalled" && event?.type === "error"
        && event.args?.[0]?.type === "string" && event.args[0].value === "Runmesh navigation failed") {
        active.navigationErrors = Math.min(exceptionLimit, active.navigationErrors + 1);
      }
      // Redirect hops keep their request ID. Retain only the first and current
      // directly targeted chains, so a fallback cannot erase the first result.
      if (message.method === "Network.requestWillBeSent" && !event?.redirectResponse && event?.request?.url === active.url
        && typeof event.requestId === "string" && event.requestId !== active.first?.id && event.requestId !== active.current?.id) {
        active.current = { id: event.requestId, type: requestType(event.type), phase: "headers_pending", status: null };
        active.first ??= { ...active.current };
        active.requests = Math.min(exceptionLimit, active.requests + 1);
      }
      const matching = [active.first, active.current].filter(request => request !== undefined && request.id === event?.requestId);
      if (message.method === "Network.requestWillBeSent" && event?.redirectResponse && matching.length) {
        active.redirects = Math.min(exceptionLimit, active.redirects + 1);
        // CDP supplies a redirect response here, without responseReceived.
        if (active.first?.id === event.requestId && active.first.status === null && statusCode(event.redirectResponse.status)) active.first.status = event.redirectResponse.status;
        for (const request of matching) request.phase = "headers_pending";
        if (active.current?.id === event.requestId) active.current.status = null;
      }
      for (const request of matching) {
        if (message.method === "Network.responseReceived") {
          request.phase = "body_pending";
          // first_status is the first observed HTTP status, including redirects;
          // status remains the current chain's final response status.
          if (request === active.current || request.status === null) request.status = statusCode(event.response?.status) ? event.response.status : null;
        } else if (message.method === "Network.loadingFinished") request.phase = "complete";
        else if (message.method === "Network.loadingFailed") request.phase = "failed";
      }
    },
    diagnostic() {
      if (!active || !locales.includes(active.locale)) return undefined;
      const elapsed = now() - active.started;
      return { locale: active.locale, phase: active.current?.phase ?? "not_started", status: active.current?.status ?? null,
        elapsed_ms: Number.isFinite(elapsed) ? Math.min(elapsedLimit, Math.max(0, Math.floor(elapsed))) : elapsedLimit,
        exception_count: active.exceptions, request_count: active.requests, request_type: active.current?.type ?? null,
        first_phase: active.first?.phase ?? "not_started", first_status: active.first?.status ?? null,
        redirect_count: active.redirects, navigation_error_count: active.navigationErrors };
    },
  };
}

export function uiNavigationDiagnosticMarker(diagnostic) {
  return marker + JSON.stringify(diagnostic);
}

export function withUiNavigationDiagnostic(error, diagnostic) {
  const failure = new Error(`${error instanceof Error ? error.message : "Browser navigation failed"}\n${uiNavigationDiagnosticMarker(diagnostic)}`, { cause: error });
  if (error instanceof Error) {
    failure.name = error.name;
    if ("code" in error) failure.code = error.code;
  }
  return failure;
}

export function uiNavigationFailureDiagnostic(text) {
  if (typeof text !== "string") return undefined;
  const raw = /^RUNMESH_E2E_UI_NAVIGATION_DIAGNOSTIC=(\{[^\r\n]{1,768}\})\r?$/mu.exec(text)?.[1];
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || !locales.includes(value.locale)
      || !phases.includes(value.phase) || !(value.status === null || statusCode(value.status))
      || !count(value.elapsed_ms, elapsedLimit) || !count(value.exception_count, exceptionLimit)) return undefined;
    const probes = value.server_probes === undefined ? undefined : serverProbe(value.server_probes);
    if (value.server_probes !== undefined && probes === undefined) return undefined;
    const diagnostic = { locale: value.locale, phase: value.phase, status: value.status,
      elapsed_ms: value.elapsed_ms, exception_count: value.exception_count };
    if (probes !== undefined) diagnostic.server_probes = probes;
    // Preserve earlier artifacts while requiring complete, validated new fields.
    const extended = ["request_count", "request_type", "first_phase", "first_status", "redirect_count", "navigation_error_count"];
    if (extended.every(key => value[key] === undefined)) return diagnostic;
    if (!count(value.request_count, exceptionLimit) || !(value.request_type === null || requestTypes.includes(value.request_type))
      || !phases.includes(value.first_phase) || !(value.first_status === null || statusCode(value.first_status))
      || !count(value.redirect_count, exceptionLimit) || !count(value.navigation_error_count, exceptionLimit)) return undefined;
    return { ...diagnostic, request_count: value.request_count, request_type: value.request_type,
      first_phase: value.first_phase, first_status: value.first_status, redirect_count: value.redirect_count, navigation_error_count: value.navigation_error_count };
  } catch { return undefined; }
}
