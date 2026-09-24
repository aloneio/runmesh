import { expect, it } from "vitest";
import { parseRemoteCall, parseRemoteEgress, parseRemoteResult, publicMcpEndpoint } from "../../apps/worker/src/contracts/remote-values.js";

it.each(["http://api.example.com/mcp", "https://127.0.0.1/mcp", "https://2130706433/mcp", "https://0x7f000001/mcp",
  "https://[::1]/mcp", "https://[::ffff:127.0.0.1]/mcp", "https://10.0.0.1/mcp", "https://169.254.169.254/mcp",
  "https://localhost/mcp", "https://api.local/mcp", "https://host.internal/mcp", "https://metadata.google.internal/mcp",
  "https://host/mcp", "https://api.example.com:8443/mcp", "https://api.example.com./mcp", "https://a@api.example.com/mcp",
  "https://api.example.com/mcp?token=a", "https://api.example.com/mcp#token", "https://*.example.com/mcp"])(
  "W05 denies non-public or ambiguous destinations: %s", value => { expect(publicMcpEndpoint(value)).toBeUndefined(); });

it("W05 policy requires exact canonical destinations and a pinned supported protocol", () => {
  const endpoint = "https://api.example.com/mcp";
  const policy = { schema_version: 1, endpoints: [{ endpoint, protocol: "2026-07-28" }] };
  expect(parseRemoteEgress(JSON.stringify(policy))).toEqual(policy.endpoints);
  expect(parseRemoteEgress(JSON.stringify({ ...policy, endpoints: [...policy.endpoints, ...policy.endpoints] }))).toBeUndefined();
  expect(parseRemoteEgress(JSON.stringify({ ...policy, endpoints: [{ endpoint, protocol: "auto" }] }))).toBeUndefined();
  expect(parseRemoteEgress(JSON.stringify({ ...policy, endpoints: [{ endpoint, protocol: "2026-07-28", headers: {} }] }))).toBeUndefined();
  expect(parseRemoteEgress(undefined)).toBeUndefined();
});

it("W05 call inputs cannot override credentials, URL, protocol or authorization", () => {
  const command = { profile_id: "docs", tool_id: "mcp." + "a".repeat(64), version: "b".repeat(64), arguments: { query: "text" } };
  expect(parseRemoteCall(command)).toEqual(command);
  for (const key of ["url", "headers", "token", "runner_id", "protocol", "scope"]) expect(parseRemoteCall({ ...command, [key]: "override" })).toBeUndefined();
  expect(parseRemoteCall({ ...command, arguments: [] })).toBeUndefined();
  expect(parseRemoteCall({ ...command, arguments: { query: "x".repeat(65_536) } })).toBeUndefined();
});

it("W05 result projection preserves standard data but never transport authentication metadata", () => {
  const content = [{ type: "text", text: "result" }, { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "audio", data: "AA==", mimeType: "audio/wav" }, { type: "resource", resource: { uri: "file:///opaque", text: "contents" } },
    { type: "resource_link", name: "document", uri: "https://unvisited.example.com/file" }];
  expect(parseRemoteResult({ content, structuredContent: { value: 1 }, isError: false, _meta: { auth: "private" } }))
    .toEqual({ content, structuredContent: { value: 1 }, isError: false });
  expect(parseRemoteResult({ content: [{ type: "tool_use", name: "shell" }] })).toBeUndefined();
  expect(parseRemoteResult({ resultType: "input_required", content: [] })).toBeUndefined();
  expect(parseRemoteResult({ task: { taskId: "opaque" }, content: [] })).toBeUndefined();
});
