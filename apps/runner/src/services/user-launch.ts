import type { ServiceManifest } from "./contracts.js";
import { ownedManifest, parseOwnedManifest } from "./manifest-ownership.js";

/** Refresh the known generated launch without replacing operator settings. */
export function ensureManagedUserLaunch(manifest: ServiceManifest): ServiceManifest {
  if (manifest.mode !== "user") return manifest;
  const parsed = parseOwnedManifest(manifest.content, "runner");
  if (parsed === undefined) throw new Error("user service launch requires a managed manifest");
  const { body } = parsed;
  let updated: string | undefined;
  if (manifest.platform === "linux") {
    const launches = [...body.matchAll(/^ExecStart=([^\r\n]*)\r?$/gmu)];
    const launch = launches[0];
    if (launches.length === 1 && [...body.matchAll(/^\s*ExecStart\s*=/gmu)].length === 1 && launch?.[1] !== undefined) {
      const argumentsMatch = /^(\S+ start(?: \S+)*?)( --profile \S+ --state-dir \S+)$/u.exec(launch[1]);
      if (argumentsMatch?.[1] !== undefined && argumentsMatch[2] !== undefined) {
        const prefix = argumentsMatch[1];
        const command = prefix.endsWith(" --user") ? launch[1] : `${prefix} --user${argumentsMatch[2]}`;
        updated = body.replace(launch[0], () => launch[0].replace(launch[1]!, () => command));
      }
    }
  } else if (manifest.platform === "darwin") {
    const launches = [...body.matchAll(/<key>ProgramArguments<\/key><array>((?:<string>[^<]*<\/string>)+)<\/array>/gu)];
    const launch = launches[0];
    if (launches.length === 1 && [...body.matchAll(/<key>ProgramArguments<\/key>/gu)].length === 1 && launch?.[1] !== undefined) {
      const argumentsMatch = /^(<string>[^<]*<\/string><string>start<\/string>(?:<string>[^<]*<\/string>)*?)(<string>--profile<\/string><string>[^<]*<\/string><string>--state-dir<\/string><string>[^<]*<\/string>)$/u.exec(launch[1]);
      if (argumentsMatch?.[1] !== undefined && argumentsMatch[2] !== undefined) {
        const prefix = argumentsMatch[1];
        const command = prefix.endsWith("<string>--user</string>") ? launch[1] : `${prefix}<string>--user</string>${argumentsMatch[2]}`;
        updated = body.replace(launch[0], () => launch[0].replace(launch[1]!, () => command));
      }
    }
  } else {
    const launches = [...body.matchAll(/<Arguments>([^<]*)<\/Arguments>/gu)];
    const launch = launches[0];
    if (launches.length === 1 && launch?.[1] !== undefined) {
      const argumentsMatch = /^(start(?: [^<\r\n]*?)?)( --profile (?:&quot;[^<]*?&quot;|[^\s<]+) --state-dir (?:&quot;[^<]*?&quot;|[^\s<]+))$/u.exec(launch[1]);
      if (argumentsMatch?.[1] !== undefined && argumentsMatch[2] !== undefined) {
        const prefix = argumentsMatch[1];
        const command = prefix.endsWith(" --user") ? launch[1] : `${prefix} --user${argumentsMatch[2]}`;
        updated = body.replace(launch[0], () => launch[0].replace(launch[1]!, () => command));
      }
    }
  }
  if (updated === undefined) throw new Error("managed user service launch must contain one Runner start command with profile and state paths");
  if (updated === body) return manifest;
  return { ...manifest, ...ownedManifest(updated, manifest.platform, "runner", parsed.newline) };
}
