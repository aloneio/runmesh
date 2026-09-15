import type { McpClientRecord, RunnerRecord } from "../registry.js";

export type AdminNotice = { readonly title: string; readonly message: string; readonly code?: string };

export type AdminData = { readonly clients: readonly McpClientRecord[]; readonly runners: readonly RunnerRecord[]; readonly jobs: readonly Record<string, unknown>[]; readonly snapshot: Record<string, unknown>; readonly notices: readonly AdminNotice[] };

export type ControlNavSection = "dashboard" | "runners" | "clients" | "settings";
