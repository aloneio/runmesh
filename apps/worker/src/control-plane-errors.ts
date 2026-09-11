/** Availability failures never prove that a Runner credential was revoked. */
export class ControlPlaneUnavailableError extends Error {
  public constructor() { super("control plane temporarily unavailable"); this.name = "ControlPlaneUnavailableError"; }
}

export function registryRejectedSession(response: Response): boolean {
  return response.status === 401 || response.status === 403 || response.status === 409;
}

export function controlPlaneUnavailableResponse(upstream?: Response): Response {
  const requested = Number(upstream?.headers.get("retry-after"));
  const retrySeconds = Number.isFinite(requested) && requested > 0 ? Math.min(900, Math.max(30, Math.ceil(requested))) : 30;
  return Response.json({ error: { code: "control_plane_unavailable", message: "Control plane is temporarily unavailable; retry later." } }, {
    status: upstream?.status === 429 ? 429 : 503,
    headers: { "cache-control": "no-store", "retry-after": String(retrySeconds) },
  });
}
