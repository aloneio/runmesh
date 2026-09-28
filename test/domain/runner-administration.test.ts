import { expect, it } from "vitest";
import { createRunner } from "../../apps/worker/src/application/create-runner.js";
import { registerRunner } from "../../apps/worker/src/application/register-runner.js";
import { regenerateRunnerEnrollment } from "../../apps/worker/src/application/runner-enrollment.js";
import { revokeRunner, rotateRunner } from "../../apps/worker/src/application/runner-credentials.js";
import { mutateRunnerPolicy } from "../../apps/worker/src/application/runner-policy.js";
import { settleRunnerMutation } from "../../apps/worker/src/application/runner-lifecycle.js";
import type { RunnerCreationPorts, RunnerRotationPorts, RunnerRevocationPorts, RunnerRegistrationPorts, RunnerEnrollmentPorts } from "../../apps/worker/src/contracts/runner-administration.js";
import type { RunnerPolicyPorts } from "../../apps/worker/src/contracts/runner-mutations.js";
const snapshot = {
  runner: {},
  configuredMode: "dedicated_user" as const,
  lifecycleId: "life"
};
const enrollment = {
  ok: true as const,
  code: "one-time-code",
  created_at_ms: 1,
  not_before_ms: 1,
  expires_at_ms: 2
};
function fixture() {
  const calls: string[] = [];
  const ports: RunnerCreationPorts & RunnerRotationPorts & RunnerRevocationPorts = {
    mutationId: () => "mutation",
    canRead: async () => {
      calls.push("read");
      return true;
    },
    fence: async (id, mutation) => {
      expect([id, mutation]).toEqual(["r", "mutation"]);
      calls.push("fence");
      return true;
    },
    create: async () => {
      calls.push("create");
      return "accepted";
    },
    rotate: async () => {
      calls.push("rotate");
      return "accepted";
    },
    revoke: async () => {
      calls.push("revoke");
      return "accepted";
    },
    observe: async () => {
      calls.push("observe");
      return {
        mutation_committed: true,
        lifecycle_id: "life"
      };
    },
    snapshot: async () => {
      calls.push("snapshot");
      return {
        state: "available",
        snapshot
      };
    },
    enroll: async () => {
      calls.push("enroll");
      return enrollment;
    },
    cancel: async () => {
      calls.push("cancel");
      return true;
    },
    finalize: async (id, mutation, changed) => {
      expect([id, mutation]).toEqual(["r", "mutation"]);
      calls.push("finalize:" + changed);
    }
  };
  return {
    calls,
    ports
  };
}
it("creation keeps one fence through enrollment and exposes the code only after finalization", async () => {
  const {
    calls,
    ports
  } = fixture();
  expect(await createRunner(ports, "r")).toEqual({
    state: "completed",
    enrollment
  });
  expect(calls).toEqual(["read", "fence", "create", "observe", "enroll", "finalize:true"]);
});
it.each([false, undefined])("creation requires committed mutation evidence (%s)", async committed => {
  const {
    calls,
    ports
  } = fixture();
  ports.observe = async () => ({
    mutation_committed: committed
  });
  expect(await createRunner(ports, "r")).toEqual({
    state: "failed",
    reason: "commit"
  });
  expect(calls).not.toContain("enroll");
});
it("creation cannot disclose an enrollment when transport cleanup fails", async () => {
  const {
    ports
  } = fixture();
  ports.finalize = async () => {
    throw new Error("offline");
  };
  expect(await createRunner(ports, "r")).toEqual({
    state: "failed",
    reason: "finalize"
  });
});
it("creation does not cancel an uncertain enrollment write", async () => {
  const {
    calls,
    ports
  } = fixture();
  ports.enroll = async () => ({
    ok: false,
    deterministic: false,
    status: 503
  });
  expect(await createRunner(ports, "r")).toEqual({
    state: "failed",
    reason: "enrollment"
  });
  expect(calls).not.toContain("cancel");
});
it("rotation observes the fenced lifecycle before changing credentials", async () => {
  const {
    calls,
    ports
  } = fixture();
  expect(await rotateRunner(ports, "r", snapshot)).toEqual({
    state: "completed",
    enrollment
  });
  expect(calls).toEqual(["fence", "snapshot", "rotate", "enroll", "finalize:true"]);
});
it.each(["lifecycle", "mode", "missing"])("rotation cancels an uncommitted fence on changed %s", async change => {
  const {
    calls,
    ports
  } = fixture();
  ports.snapshot = async () => change === "missing" ? {
    state: "missing"
  } : {
    state: "available",
    snapshot: {
      ...snapshot,
      ...(change === "lifecycle" ? {
        lifecycleId: "new"
      } : {
        configuredMode: "privileged_host" as const
      })
    }
  };
  expect(await rotateRunner(ports, "r", snapshot)).toMatchObject({
    state: "failed",
    reason: "changed"
  });
  expect(calls).toEqual(["fence", "cancel"]);
});
it.each(["invalid", "missing", "conflict"] as const)("revocation cancels only a deterministic %s rejection", async cause => {
  const {
    calls,
    ports
  } = fixture();
  ports.revoke = async () => cause;
  expect(await revokeRunner(ports, "r")).toEqual({
    state: "failed",
    reason: "write",
    cause
  });
  expect(calls).toEqual(["fence", "cancel"]);
});
it("revocation does not release a fence after unknown write outcome", async () => {
  const {
    calls,
    ports
  } = fixture();
  ports.revoke = async () => "unknown";
  expect(await revokeRunner(ports, "r")).toEqual({
    state: "failed",
    reason: "commit"
  });
  expect(calls).toEqual(["fence"]);
});
it.each([true, false])("settlement uses committed evidence before transport cleanup (%s)", async committed => {
  const {
    calls,
    ports
  } = fixture();
  ports.observe = async () => ({
    mutation_committed: committed
  });
  expect(await settleRunnerMutation(ports, "r", "mutation", true)).toBe(committed ? "committed" : "cancelled");
  expect(calls).toEqual([committed ? "finalize:true" : "cancel"]);
});
function policyFixture() {
  const f = fixture();
  const ports: RunnerPolicyPorts<string> = {
    ...f.ports,
    fence: async () => {
      f.calls.push("fence");
      return {
        ok: true
      };
    },
    change: async () => {
      f.calls.push("change");
      return {
        state: "accepted",
        value: "receipt"
      };
    },
    observe: async () => ({
      mutation_committed: true,
      policy_status: "offline_pending",
      desired_revision: 2,
      desired_checksum: "checksum"
    }),
    mark: async (_id, _mutation, phase, revision, checksum) => {
      f.calls.push("mark");
      expect([phase, revision, checksum]).toEqual(["offline_pending", 2, "checksum"]);
      return true;
    },
    push: async () => {
      f.calls.push("push");
      return {
        state: "pending"
      };
    }
  };
  return {
    ...f,
    ports
  };
}
it("offline desired policy is accepted only after committed evidence and the transport marker", async () => {
  const {
    calls,
    ports
  } = policyFixture();
  expect(await mutateRunnerPolicy(ports, "r")).toEqual({
    state: "accepted",
    value: "receipt"
  });
  expect(calls).toEqual(["fence", "change", "mark", "push"]);
});
it("unknown policy write never triggers cancellation or publication", async () => {
  const {
    calls,
    ports
  } = policyFixture();
  ports.change = async () => ({
    state: "unknown"
  });
  expect(await mutateRunnerPolicy(ports, "r")).toEqual({
    state: "failed",
    reason: "commit"
  });
  expect(calls).toEqual(["fence"]);
});
it("policy rejection preserves its receipt after confirmed cancellation", async () => {
  const {
    calls,
    ports
  } = policyFixture();
  ports.change = async () => ({
    state: "rejected",
    value: "conflict"
  });
  expect(await mutateRunnerPolicy(ports, "r")).toEqual({
    state: "rejected",
    value: "conflict"
  });
  expect(calls).toEqual(["fence", "cancel"]);
});
it("policy cannot publish after an unconfirmed transport marker", async () => {
  const {
    calls,
    ports
  } = policyFixture();
  ports.mark = async () => false;
  expect(await mutateRunnerPolicy(ports, "r")).toEqual({
    state: "failed",
    reason: "evidence"
  });
  expect(calls).not.toContain("push");
});
function registration() {
  const base = fixture();
  const ports: RunnerRegistrationPorts = {
    ...base.ports,
    read: async () => {
      base.calls.push("read");
      return "available";
    },
    write: async () => {
      base.calls.push("write");
      return "accepted";
    }
  };
  return {
    calls: base.calls,
    ports
  };
}
it("registration fences a missing Runner before writing and verifies commit before disclosure", async () => {
  const {
    calls,
    ports
  } = registration();
  ports.read = async () => "missing";
  expect(await registerRunner(ports, "r", true)).toEqual({
    state: "completed"
  });
  expect(calls).toEqual(["fence", "write", "observe", "finalize:true"]);
});
it("registration requires execution mode only for a missing Runner", async () => {
  const {
    calls,
    ports
  } = registration();
  ports.read = async () => "missing";
  expect(await registerRunner(ports, "r", false)).toEqual({
    state: "failed",
    reason: "mode_required"
  });
  expect(calls).toEqual([]);
});
it.each([true, false])("registration settles a lost response against committed evidence %s", async committed => {
  const {
    calls,
    ports
  } = registration();
  ports.write = async () => {
    throw new Error("lost response");
  };
  ports.observe = async () => ({
    mutation_committed: committed
  });
  expect(await registerRunner(ports, "r", true)).toEqual({
    state: "failed",
    reason: "commit"
  });
  expect(calls.at(-1)).toBe(committed ? "finalize:true" : "cancel");
});
it.each(["invalid", "missing", "conflict"] as const)("registration cancels a deterministic %s rejection without commit", async cause => {
  const {
    calls,
    ports
  } = registration();
  ports.write = async () => cause;
  ports.observe = async () => ({
    mutation_committed: false
  });
  expect(await registerRunner(ports, "r", true)).toEqual({
    state: "failed",
    reason: "write",
    cause
  });
  expect(calls.at(-1)).toBe("cancel");
});
it("registration reconciles a committed rejection without exposing a token", async () => {
  const {
    calls,
    ports
  } = registration();
  ports.write = async () => "conflict";
  expect(await registerRunner(ports, "r", true)).toEqual({
    state: "failed",
    reason: "post_commit"
  });
  expect(calls.at(-1)).toBe("finalize:true");
});
it.each(["unknown", "unconfirmed", "cleanup"])("registration keeps %s outcomes unavailable", async failure => {
  const {
    calls,
    ports
  } = registration();
  if (failure === "unknown") ports.write = async () => "unknown";
  if (failure === "unconfirmed") ports.observe = async () => undefined;
  if (failure === "cleanup") ports.finalize = async () => {
    throw new Error("lost response");
  };
  expect(await registerRunner(ports, "r", true)).toMatchObject({
    state: "failed",
    reason: failure === "cleanup" ? "finalize" : "commit"
  });
  expect(calls).not.toContain("cancel");
});
function regeneration() {
  const {
    calls,
    ports: base
  } = fixture();
  const ports: RunnerEnrollmentPorts = {
    ...base,
    release: async () => {
      calls.push("release");
      return {
        released: true
      };
    }
  };
  return {
    calls,
    ports
  };
}
it("regeneration releases the policy fence before disclosing the one-time code", async () => {
  const {
    calls,
    ports
  } = regeneration();
  expect(await regenerateRunnerEnrollment(ports, "r", snapshot)).toEqual({
    state: "completed",
    enrollment
  });
  expect(calls).toEqual(["fence", "snapshot", "enroll", "release"]);
});
it("regeneration preserves release diagnostics without disclosing a code", async () => {
  const {
    ports
  } = regeneration();
  ports.release = async () => ({
    released: false,
    diagnostic: "mutation_mismatch"
  });
  expect(await regenerateRunnerEnrollment(ports, "r", snapshot)).toEqual({
    state: "failed",
    reason: "cleanup",
    diagnostic: "mutation_mismatch"
  });
});
it.each([true, false])("regeneration distinguishes deterministic enrollment rejection %s", async deterministic => {
  const {
    calls,
    ports
  } = regeneration();
  ports.enroll = async () => ({
    ok: false,
    status: 404,
    deterministic
  });
  expect(await regenerateRunnerEnrollment(ports, "r", snapshot)).toMatchObject({
    state: "failed",
    reason: deterministic ? "enrollment_rejected" : "enrollment"
  });
  expect(calls.includes("cancel")).toBe(deterministic);
  expect(calls).not.toContain("release");
});
it("regeneration rejects a lifecycle replacement observed inside the fence", async () => {
  const {
    calls,
    ports
  } = regeneration();
  ports.snapshot = async () => ({
    state: "available",
    snapshot: {
      ...snapshot,
      lifecycleId: "replaced"
    }
  });
  expect(await regenerateRunnerEnrollment(ports, "r", snapshot)).toMatchObject({
    state: "failed",
    reason: "changed"
  });
  expect(calls).toEqual(["fence", "cancel"]);
});
