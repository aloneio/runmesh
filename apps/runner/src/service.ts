import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ServicePlatform = "linux" | "darwin" | "win32";
export interface ServiceManifest { readonly platform: ServicePlatform; readonly path: string; readonly content: string; readonly hash: string; }
export interface ServiceAdapterOptions { readonly platform?: ServicePlatform; readonly home?: string; readonly command?: string; readonly profilePath?: string; }
const MARKER = "remote-coding-runner-managed";

export function currentServicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform { return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "win32"; }
export function servicePath(options: ServiceAdapterOptions = {}): string {
  const platform = options.platform ?? currentServicePlatform();
  const home = options.home ?? homedir();
  if (platform === "linux") return join(home, ".config", "systemd", "user", "coding-runner.service");
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", "com.remote-coding.runner.plist");
  return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "RemoteCodingRunner", "coding-runner-task.xml");
}
export function renderService(options: ServiceAdapterOptions = {}): ServiceManifest {
  const platform = options.platform ?? currentServicePlatform();
  const path = servicePath(options);
  const command = options.command ?? "coding-runner start";
  const profile = options.profilePath ?? "";
  const body = platform === "linux" ? `[Unit]\nDescription=Remote Coding Runner\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${escapeSystemd(command)}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n` : platform === "darwin" ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.remote-coding.runner</string><key>ProgramArguments</key><array>${command.split(/\s+/).map((part) => `<string>${escapeXml(part)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>${profile === "" ? "" : `<key>EnvironmentVariables</key><dict><key>CODING_RUNNER_PROFILE</key><string>${escapeXml(profile)}</string></dict>`}</dict></plist>\n` : `<?xml version="1.0" encoding="UTF-16"?>\n<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Remote Coding Runner</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(command.split(/\s+/)[0] ?? "coding-runner")}</Command><Arguments>${escapeXml(command.split(/\s+/).slice(1).join(" "))}</Arguments></Exec></Actions></Task>\n`;
  const hash = hashContent(body);
  const marker = `${MARKER}:${hash}`;
  const content = platform === "linux" ? `# ${marker}\n${body}` : `<!-- ${marker} -->\n${body}`;
  return { platform, path, content, hash };
}
/** Only manifests with an intact marker and content hash are considered ours. */
export function isManagedService(content: string): boolean {
  const match = /(?:#|<!--)\s*remote-coding-runner-managed:([0-9a-f]{8})\s*(?:-->)?\n/.exec(content);
  if (match === null || match[1] === undefined) return false;
  const body = content.slice(match[0].length);
  return hashContent(body) === match[1];
}
export async function installServiceManifest(manifest: ServiceManifest): Promise<void> {
  const existing = await readFile(manifest.path, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
  if (existing !== undefined && !isManagedService(existing)) throw new Error(`refusing to overwrite unmanaged service manifest: ${manifest.path}`);
  await mkdir(dirname(manifest.path), { recursive: true, mode: 0o700 });
  const temporary = `${manifest.path}.${process.pid}.tmp`;
  await writeFile(temporary, manifest.content, { mode: 0o600 });
  await rename(temporary, manifest.path);
}
export async function removeServiceManifest(manifest: ServiceManifest): Promise<boolean> {
  const existing = await readFile(manifest.path, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
  if (existing === undefined) return false;
  if (!isManagedService(existing)) throw new Error(`refusing to remove unmanaged service manifest: ${manifest.path}`);
  await rm(manifest.path);
  return true;
}
export function hashContent(content: string): string { let hash = 2166136261; for (const byte of Buffer.from(content)) { hash ^= byte; hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
export function serviceCommands(action: "install" | "start" | "stop" | "restart" | "uninstall", platform: ServicePlatform = currentServicePlatform()): readonly string[] {
  if (platform === "linux") return action === "install" ? ["systemctl --user daemon-reload", "systemctl --user enable coding-runner.service"] : [`systemctl --user ${action === "uninstall" ? "disable --now" : action} coding-runner.service`];
  if (platform === "darwin") return action === "install" ? ["launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.remote-coding.runner.plist"] : [`launchctl ${action === "uninstall" ? "bootout" : action} gui/$(id -u)/com.remote-coding.runner`];
  return action === "install" ? ["schtasks /Create /TN RemoteCodingRunner /XML coding-runner-task.xml /F"] : [`schtasks /${action === "start" ? "Run" : action === "stop" ? "End" : action === "uninstall" ? "Delete" : "Run"} /TN RemoteCodingRunner`];
}
function escapeSystemd(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("\n", ""); }
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
