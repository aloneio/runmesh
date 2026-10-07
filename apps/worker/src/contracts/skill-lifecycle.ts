import type { AdminDecision } from "./connectors.js";
import type { SkillBundle, SkillHead } from "./skills.js";

export const SKILL_LIFECYCLE_LIMITS = Object.freeze({ preview_ms: 300_000, request_bytes: 8_192,
  diff_file_bytes: 16_384, diff_bytes: 131_072, diff_lines: 2_048 });
export type SkillLifecycleAction = "versions" | "compare" | "retention" | "cleanup-preview" | "cleanup";
export interface SkillVersion {
  readonly digest: string;
  readonly bytes: number;
  readonly file_count: number;
  readonly created_at_ms: number | null;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly staged: boolean;
  readonly summary: { readonly name: string; readonly description: string; readonly source: string; readonly license: string };
}
export interface SkillCapacity {
  readonly skill_bytes: number;
  readonly skill_versions: number;
  readonly library_bytes: number;
  readonly library_skills: number;
  readonly max_versions: number;
  readonly max_library_bytes: number;
  readonly max_skills: number;
}
export interface SkillVersionHistory {
  readonly state: "listed";
  readonly head: SkillHead;
  readonly versions: readonly SkillVersion[];
  readonly capacity: SkillCapacity;
}
export interface SkillVersionDiff {
  readonly state: "compared";
  readonly skill_id: string;
  readonly revision: number;
  readonly before: string;
  readonly after: string;
  readonly files: readonly {
    readonly path: string;
    readonly change: "added" | "removed" | "modified";
    readonly before_bytes: number;
    readonly after_bytes: number;
    readonly before_text?: string;
    readonly after_text?: string;
    readonly truncated: boolean;
  }[];
  readonly metadata: readonly { readonly field: "name" | "description" | "source" | "license" | "required_capabilities"; readonly before: string; readonly after: string }[];
  readonly truncated: boolean;
}
export interface SkillCleanupPlan {
  readonly fingerprint: string;
  readonly skill_id: string;
  readonly revision: number;
  readonly digests: readonly string[];
  readonly bytes: number;
  readonly expires_at_ms: number;
}
export type SkillLifecycleFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" | "unknown" | "conflict" | "expired" | "protected";
  readonly current_revision?: number };
export type SkillRetentionResult = { readonly state: "retained"; readonly head: SkillHead; readonly digest: string; readonly pinned: boolean } | SkillLifecycleFailure;
export type SkillCleanupPreview = { readonly state: "previewed"; readonly plan: SkillCleanupPlan } | SkillLifecycleFailure;
export type SkillCleanupResult = { readonly state: "cleaned"; readonly skill_id: string; readonly head: SkillHead;
  readonly deleted_digests: readonly string[]; readonly freed_bytes: number; readonly capacity: SkillCapacity } | SkillLifecycleFailure;
export type SkillLifecycleResult = SkillVersionHistory | SkillVersionDiff | SkillRetentionResult | SkillCleanupPreview | SkillCleanupResult;

/** Synchronous operations share the existing Skill content transaction owner. */
export interface SkillLifecycleRepository {
  history(id: string): SkillVersionHistory | undefined;
  bundle(id: string, digest: string): SkillBundle | undefined;
  retain(id: string, digest: string, pinned: boolean, revision: number): SkillRetentionResult;
  preview(plan: SkillCleanupPlan, sessionHash: string): SkillCleanupPreview;
  cleanup(id: string, fingerprint: string, revision: number, sessionHash: string, nowMs: number): SkillCleanupResult;
}
export interface SkillLifecyclePorts {
  readonly repository: SkillLifecycleRepository;
  readonly admin: (sessionHash: string, signal: AbortSignal) => Promise<AdminDecision>;
  readonly digest: (text: string) => Promise<string>;
  readonly now: () => number;
}
export interface CentralSkillLifecycle {
  skillLifecycle(sessionHash: string, id: string, action: SkillLifecycleAction, input: unknown): Promise<SkillLifecycleResult>;
}
