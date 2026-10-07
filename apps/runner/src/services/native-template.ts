import type { ServiceMode, ServicePlatform } from "./contracts.js";
import { escapeXml, windowsArguments } from "./escaping.js";

const daemonSettings = {
  ExecutionTimeLimit: "PT0S",
  DisallowStartIfOnBatteries: "false",
  StopIfGoingOnBatteries: "false",
} as const;

function daemonSettingsXml(): string { return Object.entries(daemonSettings).map(([key, value]) => `<${key}>${value}</${key}>`).join(""); }

/** Both programs embed this pure template in their own independent bundle. */
export function renderWindowsDaemonTask(input: { description: string; mode: ServiceMode; invocation: readonly string[]; systemAccount: "SYSTEM" | "NT AUTHORITY\\LOCAL SERVICE" }): string {
  // Task Scheduler derives ServiceAccount from the built-in UserId. Its XML
  // LogonType enumeration does not accept the COM name "ServiceAccount".
  const principal = input.mode === "system"
    ? `<UserId>${escapeXml(input.systemAccount)}</UserId><RunLevel>${input.systemAccount === "SYSTEM" ? "HighestAvailable" : "LeastPrivilege"}</RunLevel>`
    : "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>";
  const trigger = input.mode === "system" ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>" : "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
  // The optional declaration is omitted so an ownership comment may be first.
  return `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${escapeXml(input.description)}</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals><Principal id="Author">${principal}</Principal></Principals><Settings>${daemonSettingsXml()}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(input.invocation[0] ?? "")}</Command><Arguments>${escapeXml(windowsArguments(input.invocation.slice(1)))}</Arguments></Exec></Actions></Task>\n`;
}

/** Repair generated defaults while retaining explicitly configured settings. */
export function refreshNativeServiceBody(body: string, platform: ServicePlatform): string {
  if (platform === "linux") return body;
  let updated = body.replace(/^<\?xml\s[^?]*\?>\r?\n?/u, "");
  if (platform !== "win32") return updated;
  updated = updated.replace(/<LogonType>ServiceAccount<\/LogonType>/gu, "");
  const settings = [...updated.matchAll(/<Settings>([\s\S]*?)<\/Settings>/gu)];
  if (settings.length !== 1) throw new Error("managed Windows task must contain one Settings element");
  const content = settings[0]![1]!;
  let missing = "";
  for (const [key, value] of Object.entries(daemonSettings)) {
    if (!new RegExp(`<${key}(?:[ \\t\\r\\n/>])`, "u").test(content)) missing += `<${key}>${value}</${key}>`;
  }
  return updated.replace(settings[0]![0], () => `<Settings>${missing}${content}</Settings>`);
}

/** Only settings may differ when retaining an operator's manager definition. */
export function sameWindowsTaskDefinition(left: string, right: string): boolean {
  const withoutSettings = (body: string) => body.replace(/<Settings>[\s\S]*?<\/Settings>/u, "<Settings/>");
  return withoutSettings(left) === withoutSettings(right);
}
