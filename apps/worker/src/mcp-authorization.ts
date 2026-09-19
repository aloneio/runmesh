// Compatibility import path; the protected operation requirements have one source.
export { rpcPermissionRequirement } from "@aloneio/runmesh-protocol";

/** Legacy version floor for peers predating negotiated Job workspace checks.
 * Stable 0.1.1 is the minimum. A dev prerelease must have a strictly newer
 * core version: 0.1.1-dev.0 is older than 0.1.1, while 0.1.4-dev.0 is newer.
 * This is a compatibility prerequisite, never an authorization grant. */
export function supportsHistoryIndependentJobs(version: unknown): boolean {
  if (typeof version !== "string" || version.length > 128) return false;
  const parts = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-dev\.(0|[1-9][0-9]{0,12}))?$/u.exec(version);
  if (parts === null) return false;
  const newer = Number(parts[1]) > 0 || Number(parts[2]) > 1 || (Number(parts[2]) === 1 && Number(parts[3]) > 1);
  return newer || (parts[4] === undefined && parts[1] === "0" && parts[2] === "1" && parts[3] === "1");
}
