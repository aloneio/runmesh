import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  PROTOCOL_CURRENT_VERSION,
  ProtocolFrameError,
  decodeWireFrame,
  encodeWireFrame,
  generateWireMessageJsonSchema,
  negotiateProtocolVersion,
  type CapabilityMetadata,
  type JobMetadata,
  type WireMessage,
  type WorkspaceMetadata,
} from "../src/index.js";

const capabilities: CapabilityMetadata = {
  filesystem: true,
  process_execution: true,
  workspace_sync: true,
  pty: false,
  network_access: false,
  max_concurrent_jobs: 2,
  supported_rpc_methods: ["job.start", "workspace.list"],
  labels: { region: "local" },
};

const workspace: WorkspaceMetadata = {
  workspace_id: "workspace-1",
  persistence: "persistent",
  revision: "git:abc123",
  labels: { project: "example" },
};

const job: JobMetadata = {
  job_id: "job-1",
  workspace_id: workspace.workspace_id,
  status: "running",
  created_at_ms: 1_700_000_000_000,
  updated_at_ms: 1_700_000_000_001,
  runner_id: "runner-1",
};

const messages: readonly WireMessage[] = [
  {
    type: "runner.hello",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "hello-1",
    runner: {
      runner_id: "runner-1",
      runner_version: "0.1.0",
      platform: "linux",
      architecture: "x64",
      capabilities,
    },
    min_protocol_version: 1,
    max_protocol_version: 1,
  },
  {
    type: "runner.welcome",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "hello-1",
    session_id: "session-1",
    negotiated_protocol_version: 1,
    worker: { worker_id: "worker-1", worker_version: "0.1.0", capabilities },
  },
  {
    type: "runner.heartbeat",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    runner_id: "runner-1",
    sent_at_ms: 1_700_000_000_002,
    active_job_ids: [job.job_id],
  },
  {
    type: "runner.sync",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    runner_id: "runner-1",
    sync_sequence: 0,
    sent_at_ms: 1_700_000_000_003,
    workspaces: [workspace],
    jobs: [job],
  },
  {
    type: "rpc.request",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    method: "job.start",
    params: { command: "echo hello" },
    workspace,
  },
  {
    type: "rpc.response",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    result: { accepted: true },
  },
  {
    type: "rpc.error",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-2",
    error: { code: "not_found", message: "The requested job was not found" },
  },
  {
    type: "job.started",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    job,
    workspace,
    started_at_ms: 1_700_000_000_004,
  },
  {
    type: "job.output",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    job_id: job.job_id,
    workspace_id: workspace.workspace_id,
    sequence: 0,
    stream: "stdout",
    encoding: "utf-8",
    data: "hello\n",
  },
  {
    type: "job.status",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    job,
  },
  {
    type: "job.completed",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "rpc-1",
    job: { ...job, status: "succeeded" },
    completed_at_ms: 1_700_000_000_005,
    outcome: "succeeded",
    exit_code: 0,
  },
];

describe("Runner-Worker protocol", () => {
  it("round trips every defined wire message", () => {
    for (const message of messages) {
      expect(decodeWireFrame(encodeWireFrame(message))).toEqual(message);
    }
  });

  it("rejects invalid field types, missing versions, and unexpected fields", () => {
    const invalidVersion = { ...messages[0], protocol_version: "1" };
    const missingVersion = { ...messages[4] } as Record<string, unknown>;
    delete missingVersion.protocol_version;
    const unexpectedField = { ...messages[1], accidental: true };

    for (const invalid of [invalidVersion, missingVersion, unexpectedField]) {
      expect(() => encodeWireFrame(invalid as WireMessage)).toThrow(ProtocolFrameError);
      expect(() => decodeWireFrame(JSON.stringify(invalid))).toThrow(ProtocolFrameError);
    }
  });

  it("rejects an unknown message type", () => {
    expect(() =>
      decodeWireFrame(
        JSON.stringify({ type: "future.message", protocol_version: 1 }),
      ),
    ).toThrow(/does not match/);
  });

  it("rejects cyclic and over-deep RPC JSON values without recursion overflow", () => {
    let nested: { value: unknown } = { value: "leaf" };
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) {
      nested = { value: nested };
    }

    expect(() =>
      encodeWireFrame({ ...messages[5], result: nested } as WireMessage),
    ).toThrow(/invalid wire message/);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      encodeWireFrame({ ...messages[5], result: cyclic } as WireMessage),
    ).toThrow(/invalid wire message/);
  });

  it("enforces the UTF-8 payload limit on encode and decode", () => {
    const frame = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => decodeWireFrame(frame)).toThrow(/exceeds/);
    expect(() =>
      encodeWireFrame({
        ...messages[5],
        result: "x".repeat(MAX_FRAME_BYTES),
      }),
    ).toThrow(/exceeds/);
  });

  it("negotiates the highest shared major and reports unsupported ranges", () => {
    expect(
      negotiateProtocolVersion(
        { min_protocol_version: 1, max_protocol_version: 3 },
        { min_protocol_version: 2, max_protocol_version: 4 },
      ),
    ).toEqual({ ok: true, protocol_version: 3 });

    const result = negotiateProtocolVersion(
      { min_protocol_version: 1, max_protocol_version: 1 },
      { min_protocol_version: 2, max_protocol_version: 3 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported_protocol_version");
    }
  });

  it("rejects deeply nested JSON before parsing", () => {
    const frame = `${"[".repeat(MAX_JSON_DEPTH + 9)}${"]".repeat(MAX_JSON_DEPTH + 9)}`;
    expect(() => decodeWireFrame(frame)).toThrow(/nested too deeply/);
  });

  it("rejects completed jobs whose status and outcome disagree", () => {
    expect(() => encodeWireFrame({ ...messages[10], job: { ...job, status: "running" }, outcome: "succeeded", exit_code: 0 } as WireMessage)).toThrow(/invalid wire message/);
  });

  it("accepts compatible additions only beneath extensions", () => {
    expect(decodeWireFrame(JSON.stringify({ ...messages[0], extensions: { feature: true } }))).toMatchObject({ extensions: { feature: true } });
    expect(() => decodeWireFrame(JSON.stringify({ ...messages[0], feature: true }))).toThrow(/does not match/);
  });
  it("exports deterministic language-neutral JSON Schema", () => {
    const generated = generateWireMessageJsonSchema();
    const artifactPath = fileURLToPath(
      new URL("../schema/wire-message.schema.json", import.meta.url),
    );
    expect(generated).toBe(readFileSync(artifactPath, "utf8"));

    const schema = JSON.parse(generated) as {
      oneOf: readonly { properties: Record<string, unknown> }[];
    };
    expect(schema.oneOf).toHaveLength(11);
    expect(schema.oneOf[0]?.properties).toMatchObject({
      type: { const: "runner.hello" },
      protocol_version: { type: "integer" },
      request_id: { type: "string" },
    });
  });
});
