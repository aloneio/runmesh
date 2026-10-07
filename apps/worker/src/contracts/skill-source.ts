import type { SkillBundle, SkillFile, SkillMutation, SkillRepository } from "./skills.js";
import type { AdminDecision } from "./admin-session.js";

export const SKILL_SOURCE_LIMITS = Object.freeze({ files: 32, directory_depth: 8, tree_entries: 2048, metadata_bytes: 524_288, operation_ms: 25_000, active: 2 });
export interface SkillSource { readonly repository: string; readonly commit: string; readonly path: string }
export type SkillSourceFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" | "capacity" | "changed" | "unknown" };
export type SkillSourceResult = { readonly state: "previewed"; readonly source: SkillSource; readonly bundle: SkillBundle }
  | Exclude<SkillMutation, { readonly state: "previewed" }> | SkillSourceFailure | { readonly state: "source_capacity" | "busy" };
export interface SkillSourcePort {
  read(source: SkillSource, signal: AbortSignal): Promise<{ readonly state: "read"; readonly files: readonly SkillFile[] } | SkillSourceFailure>;
}
export interface SkillSourcePorts {
  readonly source: SkillSourcePort;
  readonly repository: Pick<SkillRepository, "install">;
  readonly admin: (hash: string, signal: AbortSignal) => Promise<AdminDecision>;
  readonly digest: (text: string) => Promise<string>;
}
export interface CentralSkillSource {
  skillSource(hash: string, action: "preview" | "install", input: unknown): Promise<SkillSourceResult>;
}
