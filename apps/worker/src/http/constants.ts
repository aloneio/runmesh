

export const MAX_ADMIN_BODY_BYTES = 16_384;

export const MAX_INTERNAL_RPC_BODY_BYTES = 1_048_576;

// unbounded).
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

export const ADMIN_SESSION_COOKIE = "__Host-runmesh_admin_session";

export const ADMIN_CSRF_COOKIE = "__Host-runmesh_admin_csrf";

export const SETUP_CSRF_COOKIE = "__Host-runmesh_setup_csrf";

export const LOGIN_CSRF_COOKIE = "__Host-runmesh_login_csrf";

export const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
