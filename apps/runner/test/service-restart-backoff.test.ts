import { expect, it } from "vitest";
import { renderService } from "../src/service.js";

it("renders an explicit systemd cooldown rather than inheriting the 100ms default", () => {
  const service = renderService({ platform: "linux", home: "/home/runmesh-test" });
  expect(service.content).toContain("\nRestart=on-failure\nRestartSec=30s\n");
});
