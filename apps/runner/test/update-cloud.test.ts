import { describe, expect, it } from "vitest";
import { createCloudMaintenance, maintenanceEndpoint } from "../src/updates/cloud.js";
import type { RunnerProfile } from "../src/profile.js";
import { parseProductArgs } from "../src/cli/input.js";
import { runCli } from "../src/cli.js";

const profile: RunnerProfile = { version: 1, runner_id: "runner_1", server_url: "wss://example.test/prefix/runner/connect", token: "existing-runner-token", workspaces: [], management_mode: "central", execution_mode: "dedicated_user" };
const idle = { operation: null, cloud_drained: true, cloud_uncertain: false, observed_version: null, observed_new_session: false };
describe("maintenance HTTPS and CLI", () => {
  it("polls the authenticated existing origin without redirects or an idle POST", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const cloud = createCloudMaintenance({ profile: async () => profile, fetch: (async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(idle); }) as typeof fetch });
    await expect(cloud.poll()).resolves.toEqual(idle);
    expect(calls).toHaveLength(1); expect(calls[0]?.url).toBe("https://example.test/prefix/runner/runner_1/update");
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer existing-runner-token" });
  });
  it("reloads the existing profile token for credential rotation", async () => {
    const tokens: string[] = []; let current = profile;
    const cloud = createCloudMaintenance({ profile: async () => current, fetch: (async (_url, init) => { tokens.push(new Headers(init?.headers).get("authorization")!); return Response.json(idle); }) as typeof fetch });
    await cloud.poll(); current = { ...profile, token: "rotated-existing-token" }; await cloud.poll();
    expect(tokens).toEqual(["Bearer existing-runner-token", "Bearer rotated-existing-token"]);
  });
  it.each(["ws://remote.test/runner/connect", "wss://user:secret@example.test/runner/connect", "wss://example.test/arbitrary", "wss://example.test/runner/connect?token=secret"])("rejects an invalid maintenance origin %s", server_url => {
    expect(() => maintenanceEndpoint({ ...profile, server_url })).toThrow();
  });
  it("bounds response bodies and rejects malformed control data", async () => {
    const large = createCloudMaintenance({ profile: async () => profile, fetch: (async () => new Response("{}", { headers: { "content-length": "40000" } })) as typeof fetch });
    await expect(large.poll()).rejects.toThrow("invalid maintenance response");
    const malformed = createCloudMaintenance({ profile: async () => profile, fetch: (async () => Response.json({ ...idle, operation: { target_version: "latest" } })) as typeof fetch });
    await expect(malformed.poll()).rejects.toThrow();
  });
  it("wires only the internal maintenance command to its injectable service entry point", async () => {
    const received: unknown[] = [];
    await runCli(["maintenance-agent", "--profile", "C:\\Runmesh\\profile.json", "--install-root", "C:\\Runmesh", "--user"], { startMaintenanceAgent: async options => { received.push(options); } });
    expect(received).toEqual([{ profilePath: "C:\\Runmesh\\profile.json", installRoot: "C:\\Runmesh", mode: "user" }]);
    expect(() => parseProductArgs(["install", "--install-root", "/arbitrary"])).toThrow("unknown or incomplete option");
  });
});
