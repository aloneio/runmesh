import { absoluteServicePath } from "./values.js";
import { currentServicePlatform } from "./values.js";
import { DEDICATED_SERVICE_USER } from "./values.js";
import { dedicatedIdentityFromContent } from "./identity.js";
import { dedicatedServiceIdentity } from "./identity.js";
import { escapeSystemdArgument } from "./escaping.js";
import { escapeSystemdEnvironment } from "./escaping.js";
import { escapeXml } from "./escaping.js";
import type { ExecutionMode } from "./contracts.js";
import { hashContent } from "./values.js";
import { MACOS_LABEL } from "./values.js";
import { MARKER } from "./values.js";
import { safeServiceIdentity } from "./values.js";
import type { ServiceAdapterOptions } from "./contracts.js";
import { serviceExecutionMode } from "./values.js";
import { serviceIdentityFromLine } from "./identity.js";
import { serviceInvocation } from "./layout.js";
import { serviceLayout } from "./layout.js";
import type { ServiceManifest } from "./contracts.js";
import { serviceMode } from "./values.js";
import type { ServiceMode } from "./contracts.js";
import { serviceProfilePath } from "./layout.js";
import { windowsArguments } from "./escaping.js";

export function renderService(options: ServiceAdapterOptions = {}): ServiceManifest {
  const platform = options.platform ?? currentServicePlatform();
  const mode = serviceMode(options);
  const executionMode = mode === "user" ? "dedicated_user" : serviceExecutionMode(options);
  const layout = serviceLayout(options);
  const profile = absoluteServicePath(options.profilePath ?? serviceProfilePath(layout), platform);
  const stateDir = absoluteServicePath(options.stateDir ?? layout.stateRoot, platform);
  const invocation = serviceInvocation(options, layout, profile, stateDir, platform);
  const identity = dedicatedServiceIdentity(options);
  const body = platform === "linux"
    ? renderSystemd(mode, executionMode, invocation, profile, identity)
    : platform === "darwin"
      ? renderLaunchd(mode, executionMode, invocation, identity.user)
      : renderWindowsTask(mode, executionMode, invocation);
  const hash = hashContent(body);
  const marker = `${MARKER}:${hash}`;
  const content = platform === "linux" ? `# ${marker}\n${body}` : `<!-- ${marker} -->\n${body}`;
  return { platform, mode, executionMode, path: layout.manifestPath, content, hash, serviceUser: identity.user, serviceGroup: identity.group };
}

function renderSystemd(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[], profile: string, identity: { readonly user: string; readonly group: string }): string {
  const wantedBy = mode === "system" ? "multi-user.target" : "default.target";
  const dedicatedIdentity = mode === "system" && executionMode === "dedicated_user" ? `User=${identity.user}\nGroup=${identity.group}\n` : "";
  return `[Unit]\nDescription=Runmesh Runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${dedicatedIdentity}Environment="RUNMESH_RUNNER_PROFILE=${escapeSystemdEnvironment(profile)}"\nExecStart=${invocation.map(escapeSystemdArgument).join(" ")}\nRestart=on-failure\nRestartSec=30s\n\n[Install]\nWantedBy=${wantedBy}\n`;
}

function renderLaunchd(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[], serviceUser: string): string {
  const userName = mode === "system" && executionMode === "dedicated_user" ? `<key>UserName</key><string>${escapeXml(serviceUser)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${MACOS_LABEL}</string>${userName}<key>ProgramArguments</key><array>${invocation.map((part) => `<string>${escapeXml(part)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
}

function renderWindowsTask(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[]): string {
  const principal = mode === "system"
    ? executionMode === "privileged_host"
      ? `<Principal id="Author"><UserId>SYSTEM</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>`
      : `<Principal id="Author"><UserId>NT AUTHORITY\\LOCAL SERVICE</UserId><LogonType>ServiceAccount</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`
    : `<Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`;
  const trigger = mode === "system" ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>" : "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Runmesh Runner</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals>${principal}</Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(invocation[0] ?? "")}</Command><Arguments>${escapeXml(windowsArguments(invocation.slice(1)))}</Arguments></Exec></Actions></Task>\n`;
}

/** Only manifests with an intact marker and content hash are considered ours. */
export function isManagedService(content: string): boolean {
  // The marker is an ownership boundary, not merely an annotation.  Require
  // it to be the first line so an arbitrary preamble cannot be smuggled in
  // front of a valid hash and then be treated as a native definition we own.
  const match = /^(?:#\s*|<!--\s*)runmesh-runner-managed:([0-9a-f]{8})\s*(?:-->)?\r?\n/u.exec(content);
  if (match === null || match[1] === undefined) return false;
  return hashContent(content.slice(match[0].length)) === match[1];
}

/**
 * Attach the metadata of a rendered manifest to an already validated managed
 * definition without re-rendering its body.  This is used for idempotent
 * installs and rollback so operator-supplied executable paths and service
 * options remain byte-for-byte intact.
 */
export function managedServiceManifestFromContent(manifest: ServiceManifest, content: string, executionMode: ExecutionMode = manifest.executionMode): ServiceManifest {
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  if (!isManagedService(content)) throw new Error("cannot use an unmanaged service manifest");
  const marker = /^(?:#\s*|<!--\s*)runmesh-runner-managed:[0-9a-f]{8}\s*(?:-->)?\r?\n/u.exec(content);
  if (marker === null) throw new Error("managed service manifest is malformed");
  const body = content.slice(marker[0].length);
  const identity = executionMode === "dedicated_user" ? dedicatedIdentityFromContent(manifest.platform, body) : {};
  return { ...manifest, executionMode, content, hash: hashContent(body), ...identity };
}

/**
 * Reuse an existing managed service definition while changing only its
 * execution identity.  Installers from older releases may have an explicit
 * executable path or a custom dedicated account; re-rendering from defaults
 * during migration would silently discard those operator choices.  The
 * manifest marker is checked before this transformation, and identity values
 * are restricted to the same account grammar used by the renderer.
 */
export function rewriteManagedServiceExecutionMode(manifest: ServiceManifest, existingContent: string, executionMode: ExecutionMode): ServiceManifest {
  if (manifest.mode !== "system") throw new Error("execution-mode rewrites require a system service manifest");
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  if (!isManagedService(existingContent)) throw new Error("cannot rewrite an unmanaged service manifest");
  const marker = /^(?:#\s*|<!--\s*)runmesh-runner-managed:[0-9a-f]{8}\s*(?:-->)?\r?\n/u.exec(existingContent);
  if (marker === null) throw new Error("managed service manifest is malformed");
  const body = existingContent.slice(marker[0].length);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  let rewritten = body;
  if (manifest.platform === "linux") rewritten = rewriteSystemdIdentity(body, executionMode, newline);
  else if (manifest.platform === "darwin") rewritten = rewriteLaunchdIdentity(body, executionMode);
  else rewritten = rewriteWindowsIdentity(body, executionMode);
  const hash = hashContent(rewritten);
  const content = manifest.platform === "linux" ? `# ${MARKER}:${hash}${newline}${rewritten}` : `<!-- ${MARKER}:${hash} -->${newline}${rewritten}`;
  const identity = executionMode === "dedicated_user" ? dedicatedIdentityFromContent(manifest.platform, rewritten) : {};
  return { ...manifest, executionMode, content, hash, ...identity };
}

function rewriteSystemdIdentity(body: string, executionMode: ExecutionMode, newline: string): string {
  const lines = body.split(/\r?\n/u);
  const user = serviceIdentityFromLine(lines, "User") ?? DEDICATED_SERVICE_USER;
  const group = serviceIdentityFromLine(lines, "Group") ?? user;
  if (!safeServiceIdentity(user) || !safeServiceIdentity(group)) throw new Error("managed service manifest has an invalid dedicated service identity");
  const filtered = lines.filter((line) => !/^\s*(?:User|Group)\s*=/u.test(line));
  if (executionMode === "dedicated_user") {
    const typeIndex = filtered.findIndex((line) => /^\s*Type\s*=\s*simple\s*$/u.test(line));
    if (typeIndex < 0) throw new Error("managed systemd manifest is missing its service section");
    filtered.splice(typeIndex + 1, 0, `User=${user}`, `Group=${group}`);
  }
  return filtered.join(newline);
}

function rewriteLaunchdIdentity(body: string, executionMode: ExecutionMode): string {
  const match = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(body);
  const existing = match?.[1];
  const user = existing === undefined || existing.length === 0 ? DEDICATED_SERVICE_USER : existing;
  if (!safeServiceIdentity(user)) throw new Error("managed launchd manifest has an invalid dedicated service identity");
  const withoutIdentity = body.replace(/<key>UserName<\/key><string>[^<]*<\/string>/gu, "");
  if (executionMode === "privileged_host") return withoutIdentity;
  const label = /(<key>Label<\/key><string>[^<]*<\/string>)/u;
  if (!label.test(withoutIdentity)) throw new Error("managed launchd manifest is missing its label");
  return withoutIdentity.replace(label, `$1<key>UserName</key><string>${escapeXml(user)}</string>`);
}

function rewriteWindowsIdentity(body: string, executionMode: ExecutionMode): string {
  const userId = executionMode === "privileged_host" ? "SYSTEM" : "NT AUTHORITY\\LOCAL SERVICE";
  const runLevel = executionMode === "privileged_host" ? "HighestAvailable" : "LeastPrivilege";
  if (!/<UserId>[^<]*<\/UserId>/u.test(body) || !/<RunLevel>[^<]*<\/RunLevel>/u.test(body)) throw new Error("managed Windows task manifest is missing its principal");
  return body.replace(/<UserId>[^<]*<\/UserId>/u, `<UserId>${userId}</UserId>`).replace(/<RunLevel>[^<]*<\/RunLevel>/u, `<RunLevel>${runLevel}</RunLevel>`);
}
