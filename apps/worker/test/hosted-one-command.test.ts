import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { runnerEnrollmentPage } from "../src/index.js";
import { FIXED_RELEASE_VERSION, renderPosixInstaller, renderPowerShellInstaller } from "../src/installer.js";

const origin = "https://installer.example";
const hostedEnv = { ...env, RUNMESH_TEST_MODE: undefined, RUNMESH_PUBLIC_ORIGIN: origin, RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION };
const modes = ["dedicated_user", "privileged_host"] as const;

describe("verified one-command enrollment", () => {
  it.each(modes)("renders exactly one bootstrap line per platform for %s", async (mode) => {
    const code = "C".repeat(43);
    const response = runnerEnrollmentPage(hostedEnv, origin, "runner-test", code, "csrf", false, mode, mode === "privileged_host");
    expect(response.status).toBe(200);
    const html = await response.text();
    const commands = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].slice(0, 3).map((match) => match[1]!);
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command).not.toMatch(/[\r\n]/);
      expect(command).toContain(code);
      expect(command).not.toContain("RUNNER=");
      expect(command).not.toContain("Read-Host");
      expect(command).not.toContain("read -r");
      if (mode === "dedicated_user") expect(command).toContain("execution_mode=dedicated_user");
    }
    expect(commands[0]).toContain("curl");
    expect(commands[0]).toContain("| sudo sh -s --");
    expect(commands[1]).toBe(commands[0]);
    expect(commands[2]).toContain("powershell.exe -NoProfile -NonInteractive");
    expect(html).toContain("Copy installer command");
    expect(html).toContain('<p class="eyebrow">One-command Runner setup</p>');
  });

  it("keeps the default restricted without requiring a multi-step install", async () => {
    const response = runnerEnrollmentPage(hostedEnv, origin, "runner-test", "D".repeat(43), "csrf");
    const html = await response.text();
    expect(html).toContain("install.sh?execution_mode=dedicated_user");
    expect(html).toContain("Copy installer command");
    expect(html).toContain('<p class="eyebrow">One-command Runner setup</p>');
    expect(runnerEnrollmentPage(hostedEnv, origin, "runner-test", "D".repeat(43), "csrf", false, "privileged_host", false).status).toBe(400);
  });

  it.each(modes)("serves the selected %s script without embedding credentials", async (mode) => {
    for (const extension of ["sh", "ps1"]) {
      const response = await worker.fetch(new Request(`${origin}/runner/install.${extension}?execution_mode=${mode}`, { headers: { host: "installer.example" } }), hostedEnv, {} as ExecutionContext);
      expect(response.status).toBe(200);
      const script = await response.text();
      expect(script).toContain(`--execution-mode ${mode}`);
      expect(script).not.toContain("__EXECUTION_MODE_FLAGS__");
      expect(script).toContain("signature does not verify");
      expect(script).toContain(FIXED_RELEASE_VERSION);
      if (mode === "dedicated_user") {
        expect(script).not.toContain("--execution-mode privileged_host");
        expect(script).not.toContain("--confirm-privileged-host");
      } else expect(script).toContain("--confirm-privileged-host");
      const enroll = script.split("\n").filter((line) => / enroll --profile /.test(line));
      const install = script.split("\n").filter((line) => / install --profile /.test(line));
      expect(enroll).toHaveLength(2);
      expect(install).toHaveLength(2);
      for (const line of [...enroll, ...install]) expect(line).toContain(`--execution-mode ${mode}`);
    }
  });

  it("rejects invalid or ambiguous mode requests rather than choosing elevated execution", async () => {
    for (const query of ["execution_mode=invalid", "execution_mode=", "execution_mode=dedicated_user&execution_mode=privileged_host"]) {
      for (const extension of ["sh", "ps1"]) {
        const response = await worker.fetch(new Request(`${origin}/runner/install.${extension}?${query}`), hostedEnv, {} as ExecutionContext);
        expect(response.status).toBe(400);
      }
    }
    expect(() => renderPosixInstaller(origin, "invalid" as never)).toThrow("invalid installer execution mode");
    expect(() => renderPowerShellInstaller(origin, "invalid" as never)).toThrow("invalid installer execution mode");
  });

  it("retains the explicit manual fallback only when signed distribution is disabled", async () => {
    const response = runnerEnrollmentPage({ ...hostedEnv, RUNMESH_SIGNED_RELEASE_AVAILABLE: "" }, origin, "runner-test", "E".repeat(43), "csrf");
    expect(await response.text()).toContain('<p class="eyebrow">Manual portable-artifact enrollment</p>');
  });
});
