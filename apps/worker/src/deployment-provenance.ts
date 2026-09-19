import { BUILD_PROVENANCE } from "./generated-provenance.js";

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const branch = (value: unknown): value is "main" | "dev" => value === "main" || value === "dev";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const reasons = new Set(["git_unavailable", "hidden_index_flags", "unsupported_tree", "dirty_checkout", "metadata_conflict", "source_changed"]);

/** Pure white-list projection. Provider tags are corroborating metadata, not
 * a substitute for a known build. No database, clock, environment discovery
 * or network I/O occurs here, including while the control database is down.
 */
export function deploymentProvenance(env: { CF_VERSION_METADATA?: unknown }, compiled: unknown = BUILD_PROVENANCE) {
  const build = object(compiled) ? compiled : {};
  const clean = build.schema_version === 1 && build.state === "clean" && hash(build.commit) && hash(build.tree) && (build.branch === null || branch(build.branch)) && build.reason === null;
  const buildState = clean ? "clean" : build.schema_version === 1 && typeof build.state === "string" && ["dirty", "unavailable", "conflict"].includes(build.state) && build.commit === null && build.tree === null && build.branch === null && typeof build.reason === "string" && reasons.has(build.reason) ? String(build.state) : "invalid";
  const raw = object(env.CF_VERSION_METADATA) ? env.CF_VERSION_METADATA : {};
  const tag = typeof raw.tag === "string" && raw.tag.length <= 64 ? /^(main|dev):([a-f0-9]{40})$/u.exec(raw.tag) : null;
  const timestamp = typeof raw.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(raw.timestamp) && Number.isFinite(Date.parse(raw.timestamp)) ? new Date(raw.timestamp).toISOString() : null;
  const provider = {
    version_id: typeof raw.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(raw.id) ? raw.id.toLowerCase() : null,
    created_at: timestamp,
    tag_state: tag !== null ? "recognized" : raw.tag === undefined || raw.tag === "" ? "absent" : "unrecognized",
    branch: tag?.[1] ?? null,
    commit: tag?.[2] ?? null,
  };
  const conflict = clean && tag !== null && (tag[2] !== build.commit || (build.branch !== null && tag[1] !== build.branch));
  const identified = clean && !conflict;
  return {
    schema_version: 1,
    branch: identified ? build.branch ?? tag?.[1] ?? null : null,
    commit: identified ? build.commit as string : null,
    tree: identified ? build.tree as string : null,
    state: conflict || buildState === "conflict" ? "conflict" : identified ? "identified" : "unavailable",
    source: identified ? "git_build" : null,
    build_state: buildState,
    reason: conflict ? "provider_mismatch" : clean ? null : buildState === "invalid" ? "invalid_build_record" : build.reason,
    agreement: conflict ? "conflict" : clean && tag !== null ? "matched" : "not_comparable",
    attestation: "self_reported",
    provider,
  };
}
