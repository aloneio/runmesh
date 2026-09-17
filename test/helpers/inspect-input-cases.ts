export interface InspectInputCase {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly valid: boolean;
}

const revision = "a".repeat(40);
const bases = [
  { action: "list", workspace_id: "workspace" },
  { action: "search", workspace_id: "workspace", query: "needle" },
  { action: "stat", workspace_id: "workspace", path: "tracked.txt" },
  { action: "git_status", workspace_id: "workspace" },
  { action: "git_diff", workspace_id: "workspace" },
  { action: "git_log", workspace_id: "workspace", path: "tracked.txt" },
  { action: "git_show", workspace_id: "workspace", path: "tracked.txt", revision },
  { action: "git_blame", workspace_id: "workspace", path: "tracked.txt" },
  { action: "diagnostics", workspace_id: "workspace" },
] as const;

// The same JSON inputs exercise the runtime parser and independently
// interpreted tools/list schema. Preserve legacy common cursor/limit inputs.
export const inspectInputCases: readonly InspectInputCase[] = [
  ...bases.flatMap((base): InspectInputCase[] => [
    { name: `${base.action}: minimal`, input: base, valid: true },
    { name: `${base.action}: revision`, input: { ...base, revision }, valid: base.action === "git_show" },
    ...["start_line", "end_line"].map(key => ({ name: `${base.action}: ${key}`, input: { ...base, [key]: 1 }, valid: base.action === "git_blame" })),
    ...Object.entries({ query: "needle", mode: "literal", case_sensitive: true, include_globs: ["*.ts"], exclude_globs: ["*.log"], context_before: 1, context_after: 1 }).map(([key, value]) => ({
      name: `${base.action}: ${key}`, input: { ...base, [key]: value }, valid: base.action === "search",
    })),
    { name: `${base.action}: search cursor`, input: { ...base, cursor: "s1:" + "a".repeat(16) + ":0" }, valid: base.action === "search" },
    { name: `${base.action}: legacy cursor`, input: { ...base, cursor: "0" }, valid: true },
    { name: `${base.action}: legacy limit`, input: { ...base, max_results: 10 }, valid: true },
    { name: `${base.action}: unknown field`, input: { ...base, unexpected: true }, valid: false },
  ]),
  ...["stat", "git_log", "git_show", "git_blame"].map(action => ({ name: `${action}: missing path`, input: { action, workspace_id: "workspace", ...(action === "git_show" ? { revision } : {}) }, valid: false })),
  { name: "search: missing query", input: { action: "search", workspace_id: "workspace" }, valid: false },
  { name: "git_show: missing revision", input: { action: "git_show", workspace_id: "workspace", path: "tracked.txt" }, valid: false },
  ...["HEAD", null, 42, "f".repeat(65)].map(value => ({ name: `git_show: malformed revision ${String(value)}`, input: { action: "git_show", workspace_id: "workspace", path: "tracked.txt", revision: value }, valid: false })),
  { name: "git_show: abbreviated revision", input: { action: "git_show", workspace_id: "workspace", path: "tracked.txt", revision: "ABC1234" }, valid: true },
  { name: "git_blame: partial line range", input: { action: "git_blame", workspace_id: "workspace", path: "tracked.txt", end_line: 10 }, valid: true },
  { name: "git_blame: invalid line bound", input: { action: "git_blame", workspace_id: "workspace", path: "tracked.txt", start_line: 0 }, valid: false },
  { name: "unknown action", input: { action: "git_checkout", workspace_id: "workspace" }, valid: false },
  { name: "missing workspace", input: { action: "list" }, valid: false },
  { name: "missing action", input: { workspace_id: "workspace" }, valid: false },
];
