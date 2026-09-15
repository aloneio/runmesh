

export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }

export function time(value: number | null): string { return value === null || value <= 0 ? "Never" : new Date(value).toISOString(); }

export function statusClass(status: string): string { return ["queued", "running", "cancelling", "cancelled", "succeeded", "completed", "failed", "unknown", "interrupted", "pending", "invalid", "offline", "online", "valid", "permission_denied", "not_directory", "invalid_path", "missing"].includes(status) ? status : "unknown"; }

export function shortChecksum(value: unknown): string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? `${value.slice(0, 12)}…` : "—"; }

export function displayScopeLabel(scope: string): string {
  switch (scope) {
    case "coding:read":
      return "Read";
    case "coding:write":
      return "Write";
    case "coding:exec":
      return "Exec";
    default:
      return scope.startsWith("coding:") ? scope.slice("coding:".length) : scope;
  }
}

export { arrayField } from "../values.js";
export { record } from "../values.js";
