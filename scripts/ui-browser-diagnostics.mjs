// A single navigation observation. URLs and request IDs only match local CDP
// events; the retained failure record contains fixed labels and bounded counts.
const phases = ["not_started", "headers_pending", "body_pending", "complete", "failed"];
const locales = ["en", "zh-CN"];
const marker = "RUNMESH_E2E_UI_NAVIGATION_DIAGNOSTIC=";
const elapsedLimit = 600000, exceptionLimit = 1000;
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599;
const count = (value, limit) => Number.isInteger(value) && value >= 0 && value <= limit;

export function createUiNavigationDiagnostic({ now = Date.now } = {}) {
  let active;
  return {
    begin(url, locale, sessionId) {
      active = { url, locale, sessionId, started: now(), phase: "not_started", status: null, exceptions: 0 };
    },
    observe(message) {
      if (!active || message.sessionId !== active.sessionId) return;
      const event = message.params;
      if (message.method === "Runtime.exceptionThrown") active.exceptions = Math.min(exceptionLimit, active.exceptions + 1);
      if (message.method === "Network.requestWillBeSent" && event?.request?.url === active.url) {
        active.requestId = event.requestId; active.phase = "headers_pending"; active.status = null;
      } else if (active.requestId !== undefined && event?.requestId === active.requestId) {
        if (message.method === "Network.responseReceived") {
          active.phase = "body_pending"; active.status = statusCode(event.response?.status) ? event.response.status : null;
        } else if (message.method === "Network.loadingFinished") active.phase = "complete";
        else if (message.method === "Network.loadingFailed") active.phase = "failed";
      }
    },
    diagnostic() {
      if (!active || !locales.includes(active.locale)) return undefined;
      const elapsed = now() - active.started;
      return { locale: active.locale, phase: active.phase, status: active.status,
        elapsed_ms: Number.isFinite(elapsed) ? Math.min(elapsedLimit, Math.max(0, Math.floor(elapsed))) : elapsedLimit,
        exception_count: active.exceptions };
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
  const raw = /^RUNMESH_E2E_UI_NAVIGATION_DIAGNOSTIC=(\{[^\r\n]{1,256}\})\r?$/mu.exec(text)?.[1];
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || !locales.includes(value.locale)
      || !phases.includes(value.phase) || !(value.status === null || statusCode(value.status))
      || !count(value.elapsed_ms, elapsedLimit) || !count(value.exception_count, exceptionLimit)) return undefined;
    return { locale: value.locale, phase: value.phase, status: value.status,
      elapsed_ms: value.elapsed_ms, exception_count: value.exception_count };
  } catch { return undefined; }
}
