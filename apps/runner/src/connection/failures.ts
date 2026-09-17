export class RunnerAuthenticationError extends Error {
  public constructor(message = "runner credentials were rejected") { super(message); this.name = "RunnerAuthenticationError"; }
}

/** Session fencing requires a fresh handshake, not credential replacement. */
export class RunnerSessionConflictError extends Error {
  public constructor() { super("runner session is stale or was replaced; reconnecting"); this.name = "RunnerSessionConflictError"; }
}

export class RunnerServiceUnavailableError extends Error {
  public constructor(message = "runner service temporarily unavailable", public readonly retryAfterMs = 30_000) {
    super(message); this.name = "RunnerServiceUnavailableError";
  }
}

/** Only explicit credential/protocol rejection is fatal, not matching words in an outage message. */
export function classifyConnectionFailure(input: { readonly statusCode?: number; readonly closeCode?: number; readonly reason?: string; readonly error?: unknown }): "authentication" | "network" {
  if (input.error instanceof RunnerAuthenticationError) return "authentication";
  if (input.statusCode !== undefined) return input.statusCode === 401 || input.statusCode === 403 ? "authentication" : "network";
  if (input.closeCode === 4001 || input.closeCode === 1002) return "authentication";
  // Older Workers used 1008 for an explicit handshake rejection. Never let
  // legacy wording override a service-failure code or arbitrary network error.
  if (input.closeCode === 1008 && /^(?:stale credentials|credentials revoked|unauthorized|forbidden|unsupported_protocol_version)$/i.test(input.reason ?? "")) return "authentication";
  return "network";
}
