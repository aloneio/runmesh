import type { ParsedCommand } from "./contracts.js";
import { ProfileStore } from "../profile.js";
import type { RunnerProfile } from "../profile.js";
import { serviceLayout } from "../service.js";
import type { ServicePlatform } from "../service.js";
import { serviceProfilePath } from "../service.js";

export function parseProductArgs(argv: readonly string[]): ParsedCommand {
  const command = argv[0] ?? ""; const values: Record<string, string | boolean | string[]> = {}; const passthrough: string[] = [];
  if (command === "manager-refresh") {
    const options = new Map([["--profile", "profilePath"], ["--install-root", "installRoot"], ["--release-dir", "releaseDirectory"]]);
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index]!;
      if (arg === "--json" || arg === "--user") {
        const key = arg.slice(2);
        if (Object.hasOwn(values, key)) throw new Error(`duplicate option: ${arg}`);
        values[key] = true; continue;
      }
      const key = options.get(arg), value = argv[index + 1];
      if (key === undefined || value === undefined || value.length === 0 || value.startsWith("-")) throw new Error(`unknown or incomplete option: ${arg}`);
      if (Object.hasOwn(values, key)) throw new Error(`duplicate option: ${arg}`);
      values[key] = value; index += 1;
    }
    for (const [option, key] of options) if (values[key] === undefined) throw new Error(`${option} is required`);
    return { command, json: values.json === true, values, passthrough };
  }
  if (command === "start") {
    const rest = argv.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === undefined) continue;
      if (arg === "--json") { values.json = true; continue; }
      if (arg === "--user") { values.user = true; continue; }
      if (arg === "--profile") {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error("unknown or incomplete option: --profile");
        values.profilePath = value as string; index += 1; continue;
      }
      passthrough.push(arg);
    }
    return { command, json: values.json === true, values, passthrough };
  }
  const rest = [...argv.slice(1)];
  if (command === "workspace" && rest[0] === "list") values.action = rest.shift() as string;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { values.json = true; continue; }
    if (arg === "--purge") { values.purge = true; continue; }
    if (arg === "--yes") { values.yes = true; continue; }
    if (arg === "--insecure-local") { values.insecureLocal = true; continue; }
    if (arg === "--re-enroll") { values.reEnroll = true; continue; }
    if (arg === "--user") { values.user = true; continue; }
    if (arg === "--confirm-privileged-host") { values.confirmPrivilegedHost = true; continue; }
    if (arg === "--code-stdin") { values.codeStdin = true; continue; }
    if (arg === "--shareable" && command === "doctor") { values.shareable = true; continue; }
    const key = arg === "--install-root" && command === "maintenance-agent" ? "installRoot" : arg === "--execution-mode" ? "executionMode" : arg === "--server" ? "server" : arg === "--code" ? "code" : arg === "--cwd" ? "cwd" : arg === "--executable-path" ? "executablePath" : arg === "--profile" ? "profilePath" : undefined;
    const value = rest[index + 1];
    // Issued base64url enrollment codes can start with two hyphens. Match their
    // exact length so a following option still reports a missing code value.
    const enrollmentValue = command === "enroll" && key === "code" && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
    if (key === undefined || value === undefined || (value.startsWith("--") && !enrollmentValue)) throw new Error(`unknown or incomplete option: ${arg}`);
    values[key] = value; index += 1;
  }
  return { command, json: values.json === true, values, passthrough };
}

export function storeFor(parsed: ParsedCommand, platform?: ServicePlatform): ProfileStore {
  if (typeof parsed.values.profilePath === "string") return new ProfileStore({ filePath: parsed.values.profilePath, ...(platform === undefined ? {} : { platform }) });
  if (parsed.values.user === true || process.env.RUNMESH_RUNNER_PROFILE !== undefined) return new ProfileStore(platform === undefined ? {} : { platform });
  const layout = serviceLayout({ ...(platform === undefined ? {} : { platform }), mode: "system" });
  return new ProfileStore({ filePath: serviceProfilePath(layout), ...(platform === undefined ? {} : { platform }) });
}

export function requiredString(parsed: ParsedCommand, name: string): string { const value = parsed.values[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`); return value; }

export async function requireProfile(store: ProfileStore): Promise<RunnerProfile> { const profile = await store.load(); if (profile === undefined) throw new Error("runner is not enrolled"); return profile; }
