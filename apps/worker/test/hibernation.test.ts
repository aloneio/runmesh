import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Durable Object hibernation helper availability", () => {
  it("reports the documented non-running state for an idle object", async () => {
    const object = env.RUNNER.get(env.RUNNER.idFromName("hibernation-idle-test"));
    await expect(evictDurableObject(object)).rejects.toThrow("not currently running");
  });
});
