import { message } from "../i18n/messages.js";
import type { CodingScope } from "../contracts/administration.js";
import { escapeHtml, record, statusClass } from "./format.js";
import { isFullHostPath } from "./host-path-label.js";

export function passwordToggle(): string {
  return `<button type="button" class="pwd-toggle-btn" aria-label="Show password">
    <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
  </button>`;
}

export function permissionSelect(name: string, selected: boolean): string { return `<label class="perm-select-label"><span>${escapeHtml(name.replaceAll("_", " "))}</span><select name="${escapeHtml(name)}"><option value="true"${selected ? " selected" : ""}>${message("text.allow", "en")}</option><option value="false"${selected ? "" : " selected"}>${message("text.deny", "en")}</option></select></label>`; }

export function scopeCheckboxes(selected: readonly string[] = ["coding:read"]): string {
  const descriptions: Record<CodingScope, string> = {
    "coding:read": "Inspect workspaces and read files.",
    "coding:write": "Apply approved edits.",
    "coding:exec": "Use Host shell and control Jobs.",
  };
  const titles: Record<CodingScope, string> = {
    "coding:read": "Read",
    "coding:write": "Write",
    "coding:exec": "Exec",
  };
  return (["coding:read", "coding:write", "coding:exec"] as const).map((scope) => `<label class="check"><input type="checkbox" name="scopes" value="${scope}"${selected.includes(scope) ? " checked" : ""}> <span><strong>${titles[scope]}</strong><small>${descriptions[scope]}</small></span></label>`).join("");
}

export function permissionForm(runnerId: string, permissions: Record<string, unknown> | undefined, csrf: string): string {
  const current = (name: string): boolean => permissions?.[name] === true;
  return `<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/permissions" class="form-grid permission-profile-grid">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <div class="perm-selects-row">
      ${permissionSelect("read", current("read"))}
      ${permissionSelect("edit", current("edit"))}
      ${permissionSelect("shell", current("shell"))}
      ${permissionSelect("job_control", current("job_control"))}
    </div>
    <div class="form-submit-wrap full-width-submit">
      <button class="button">${message("text.save.profile", "en")}</button>
    </div>
  </form>`;
}

export function workspaceProfile(permissions: Record<string, unknown> | undefined): "custom" | "read_only" | "edit_only" | "controlled_exec" {
  if (permissions?.read === true && permissions.edit !== true && permissions.shell !== true && permissions.job_control !== true) return "read_only";
  if (permissions?.read === true && permissions.edit === true && permissions.shell !== true && permissions.job_control !== true) return "edit_only";
  if (permissions?.read === true && permissions.edit === true && permissions.shell === true && permissions.job_control === true) return "controlled_exec";
  return "custom";
}

export function managedWorkspaceForm(runnerId: string, workspace: Record<string, unknown> | undefined, csrf: string): string {
  const existing = typeof workspace?.workspace_id === "string";
  const workspaceId = existing ? workspace?.workspace_id as string : "";
  const displayName = typeof workspace?.display_name === "string" ? workspace.display_name : "";
  const rootPath = typeof workspace?.root_path === "string" ? workspace.root_path : "";
  const permissions = record(workspace?.permissions);
  const current = (name: string): boolean => permissions?.[name] === true;
  const profile = workspaceProfile(permissions);
  const fullHostConfirmed = isFullHostPath(rootPath);
  const enabled = workspace?.enabled !== false;
  const status = typeof workspace?.validation_status === "string" ? workspace.validation_status : "pending";
  return `<li class="workspace-card">
    <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/${existing ? "workspace-update" : "workspace-create"}" class="workspace-form">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <div class="form-grid workspace-main-grid">
        <label>Workspace ID
          <input name="workspace_id" value="${escapeHtml(workspaceId)}" ${existing ? "readonly" : "required"} maxlength="128" placeholder="e.g. project-src">
        </label>
        <label>Display name
          <input name="display_name" value="${escapeHtml(displayName)}" required maxlength="256" placeholder="e.g. Main Repository">
        </label>
        <label class="grid-span-2">Absolute root path
          <input name="root_path" value="${escapeHtml(rootPath)}" required maxlength="4096" placeholder="/absolute/path/to/directory">
        </label>
        <label>Usage profile
          <select name="profile">
            <option value="custom"${profile === "custom" ? " selected" : ""}>${message("text.custom", "en")}</option>
            <option value="read_only"${profile === "read_only" ? " selected" : ""}>${message("text.read.only", "en")}</option>
            <option value="edit_only"${profile === "edit_only" ? " selected" : ""}>${message("text.workspace.edit", "en")}</option>
            <option value="controlled_exec"${profile === "controlled_exec" ? " selected" : ""}>${message("text.controlled.execution", "en")}</option>
          </select>
        </label>
        <label>Enabled
          <select name="enabled">
            <option value="true"${enabled ? " selected" : ""}>${message("text.enabled", "en")}</option>
            <option value="false"${enabled ? "" : " selected"}>${message("text.disabled", "en")}</option>
          </select>
        </label>
        <label class="full-host-label">Full-host confirmation
          <input type="hidden" name="confirm_full_host" value="false">
          <span class="check-line">
            <input type="checkbox" name="confirm_full_host" value="true"${fullHostConfirmed ? " checked" : ""}>
            <span>${message("text.i.understand.this.exposes.the.full.host.filesystem", "en")}</span>
          </span>
        </label>
      </div>
      <div class="workspace-perms-section">
        <span class="form-stat-label">${message("text.workspace.permissions", "en")}</span>
        <div class="perm-selects-row">
          ${permissionSelect("read", current("read"))}
          ${permissionSelect("edit", current("edit"))}
          ${permissionSelect("shell", current("shell"))}
          ${permissionSelect("job_control", current("job_control"))}
        </div>
      </div>
      <div class="workspace-btn-bar">
        <button class="button">${existing ? "Save workspace" : "Create workspace"}</button>
      </div>
    </form>
    ${existing ? `<div class="workspace-footer">
      <span class="validation-tag status-pill ${statusClass(status)}">Validation: ${escapeHtml(status)}</span>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/workspace-delete" class="inline-delete-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="workspace_id" value="${escapeHtml(workspaceId)}">
        <label>Type Workspace ID to confirm
          <input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required placeholder="${escapeHtml(workspaceId)}">
        </label>
        <button class="small danger">${message("text.delete.workspace", "en")}</button>
      </form>
    </div>` : ""}
  </li>`;
}
