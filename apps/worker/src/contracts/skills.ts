import type { CapturedIdentity, IdentityDecision } from "./identity.js";
import type { CapabilityTarget } from "./capabilities.js";
import type { AdminDecision } from "./connectors.js";

export const SKILL_LIMITS = Object.freeze({ files: 32, file_bytes: 65_536, bundle_bytes: 262_144, request_bytes: 524_288,
  skills: 1_000, versions: 32, storage_bytes: 16_777_216, page: 128, dependencies: 8, operation_ms: 5_000 });
export type SkillDependencyState = "configured" | "not_configured" | "disabled" | "incompatible" | "unavailable";
export interface SkillDependency { readonly target: CapabilityTarget; readonly state: SkillDependencyState }
export interface SkillFile { readonly path: string; readonly text: string }
export interface SkillBundle { readonly schema_version: 1; readonly skill_id: string; readonly name: string; readonly description: string;
  readonly source: string; readonly license: string; readonly files: readonly SkillFile[]; readonly digest: string; readonly required_capabilities?: readonly CapabilityTarget[] }
export interface SkillHead { readonly skill_id: string; readonly revision: number; readonly staged_digest: string;
  readonly active_digest: string | null; readonly enabled: boolean }
export type SkillFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" | "capacity" | "unknown" };
export type SkillMutation = { readonly state: "written"; readonly head: SkillHead }
  | { readonly state: "previewed"; readonly bundle: SkillBundle } | { readonly state: "conflict"; readonly current_revision: number } | SkillFailure;
export type SkillInspection = { readonly state: "found"; readonly head: SkillHead; readonly bundle: SkillBundle } | SkillFailure;
export interface SkillSummary { readonly skill_id: string; readonly digest: string; readonly name: string; readonly description: string;
  readonly source: string; readonly license: string; readonly revision: number; readonly required_capabilities?: readonly CapabilityTarget[] }
export type SkillPage = { readonly state: "listed"; readonly skills: readonly SkillSummary[]; readonly next_after: string | null } | SkillFailure;
export type SkillLibraryPage = { readonly state: "listed"; readonly skills: readonly { readonly head: SkillHead; readonly summary: Omit<SkillSummary, "revision"> }[]; readonly next_after: string | null } | SkillFailure;
export type SkillContent = { readonly state: "read"; readonly skill_id: string; readonly digest: string; readonly path: string; readonly text: string; readonly dependencies: readonly SkillDependency[] } | SkillFailure;
export interface SkillRepository {
  heads(after: string, limit: number): readonly SkillHead[];
  approved(id: string, digest: string): boolean;
  head(id: string): SkillHead | undefined;
  bundle(id: string, digest: string): SkillBundle | undefined;
  summary(id: string, digest: string): Omit<SkillSummary, "revision"> | undefined;
  stage(bundle: SkillBundle, revision: number): SkillMutation;
  install(bundle: SkillBundle, revision: number): SkillMutation;
  activate(id: string, digest: string, revision: number): SkillMutation;
  disable(id: string, revision: number): SkillMutation;
}
export interface SkillPorts { readonly repository: SkillRepository; readonly digest: (text: string) => Promise<string>;
  readonly remoteDependency?: (target: Extract<CapabilityTarget, { kind: "remote_tool" }>, signal: AbortSignal) => Promise<SkillDependencyState>;
  readonly identity: (principal: CapturedIdentity, signal: AbortSignal) => Promise<IdentityDecision>;
  readonly admin: (sessionHash: string, signal: AbortSignal) => Promise<AdminDecision> }
export interface CentralSkills {
  installSkill(sessionHash: string, input: unknown): Promise<SkillMutation>;
  listSkillLibrary(sessionHash: string, after?: string): Promise<SkillLibraryPage>;
  mutateSkill(sessionHash: string, input: unknown): Promise<SkillMutation>;
  inspectSkill(sessionHash: string, id: string, digest?: string): Promise<SkillInspection>;
  listSkills(principal: CapturedIdentity, query: unknown): Promise<SkillPage>;
  readSkill(principal: CapturedIdentity, input: unknown): Promise<SkillContent>;
}
