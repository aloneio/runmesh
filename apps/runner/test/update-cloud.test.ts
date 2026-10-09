import { describe, expect, it } from "vitest";
import { createCloudMaintenance, maintenanceEndpoint } from "../src/updates/cloud.js";
import { MaintenanceHttpError } from "../src/updates/contracts.js";
import type { RunnerProfile } from "../src/profile.js";
import { maintenanceIdentity } from "../src/maintenance-contract.js";
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
  it.each([
    ["/runner/connect", "/runner/runner_1/update"],
    ["/runner/connect/", "/runner/runner_1/update"],
    ["/prefix/runner/connect///", "/prefix/runner/runner_1/update"],
  ])("polls an accepted profile path %s through its canonical maintenance endpoint", async (path, expectedPath) => {
    const identity = maintenanceIdentity({ ...profile, server_url: `wss://example.test${path}` });
    expect(identity).toBeDefined();
    const urls: string[] = [];
    const cloud = createCloudMaintenance({ profile: async () => identity!, fetch: (async url => {
      urls.push(String(url)); return Response.json(idle);
    }) as typeof fetch });
    await expect(cloud.poll()).resolves.toEqual(idle);
    expect(urls).toEqual([`https://example.test${expectedPath}`]);
  });
  it.each([401, 403, 409, 429, 503])("exposes HTTP %s through the coordinator's error contract", async status => {
    const cloud = createCloudMaintenance({ profile: async () => profile, fetch: (async () => new Response("upstream detail", { status })) as typeof fetch });
    const request = cloud.poll();
    await expect(request).rejects.toBeInstanceOf(MaintenanceHttpError);
    await expect(request).rejects.toMatchObject({ status, message: `maintenance_http_${status}` });
  });
  it.each([429, 503])("retains the retry window for HTTP %s without exposing the response body", async status => {
    const cloud = createCloudMaintenance({ profile: async () => profile, fetch: (async () => new Response("private-provider-body", { status, headers: { "retry-after": "120" } })) as typeof fetch });
    await expect(cloud.poll()).rejects.toMatchObject({ status, retryAfterMs: 120_000, message: `maintenance_http_${status}` });
  });
  it.each([["invalid", 30_000], ["0", 30_000], ["999999", 900_000]])("bounds the maintenance retry header %s", async (value, expected) => {
    const cloud = createCloudMaintenance({ profile: async () => profile, fetch: (async () => new Response("", { status: 503, headers: { "retry-after": String(value) } })) as typeof fetch });
    await expect(cloud.poll()).rejects.toMatchObject({ retryAfterMs: expected });
  });
  it.each(["ws://remote.test/runner/connect", "wss://user:secret@example.test/runner/connect", "wss://example.test/arbitrary", "wss://example.test/arbitrary/", "wss://example.test/runner/connect?token=secret", "wss://example.test/runner/connect/?token=secret", "wss://example.test/runner/connect/#fragment"])("rejects an invalid maintenance origin %s", server_url => {
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
