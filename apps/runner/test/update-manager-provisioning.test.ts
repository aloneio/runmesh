import { expect, it } from "vitest";
import { createServiceProvisioner, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";

it.each(["linux", "darwin"] as const)("keeps the independent manager outside %s package permission changes", async platform => {
  const commands: { file: string; args: readonly string[] }[] = [];
  const layout = serviceLayout({ platform, mode: "system" });
  await createServiceProvisioner({ platform, executor: { execute: async (file, args) => {
    commands.push({ file, args });
    return { exitCode: 0, stdout: "PrimaryGroupID: 501" };
  } } }).provision(renderService({ platform, mode: "system" }), serviceProfilePath(layout));
  const traversals = commands.filter(command => command.file === "find" && command.args.includes(layout.installRoot));
  expect(traversals).toHaveLength(4);
  for (const { args } of traversals) {
    const prune = args.indexOf("-prune");
    expect(args.slice(prune - 2, prune + 2)).toEqual(["-path", `${layout.installRoot}/manager`, "-prune", "-o"]);
    expect(prune).toBeLessThan(args.indexOf("-exec"));
  }
  expect(commands.some(command => command.file === "find" && command.args.includes(layout.stateRoot) && command.args.includes("0600"))).toBe(true);
});

it("keeps the protected manager ACL outside Windows Runner provisioning recursion", async () => {
  let script = "";
  const layout = serviceLayout({ platform: "win32", mode: "system" });
  await createServiceProvisioner({ platform: "win32", executor: { execute: async (_file, args) => { script = args.at(-1)!; return { exitCode: 0 }; } } })
    .provision(renderService({ platform: "win32", mode: "system" }), serviceProfilePath(layout));
  expect(script).toContain("& icacls 'C:\\Program Files\\Runmesh' /reset | Out-Null");
  expect(script).not.toContain("& icacls 'C:\\Program Files\\Runmesh' /reset /T");
  expect(script).toContain("if([System.IO.Path]::GetFileName($entry) -ine 'manager')");
  expect(script).toContain("& icacls $entry /reset /T");
  expect(script).toContain("NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)M");
});
