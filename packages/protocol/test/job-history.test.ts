import { expect, it } from "vitest";
import { parseJobHistorySettings } from "../src/index.js";

const settings = { mode: "batched", interval_seconds: 300, retention_days: 7, local_retention_days: 0 };

it("accepts the supported upload and retention policies without modifying the input", () => {
  for (const mode of ["off", "batched", "immediate"]) {
    for (const interval_seconds of [60, 300, 900, 3600]) {
      for (const retention_days of [1, 3, 7, 14, 30, 90]) {
        for (const local_retention_days of [0, 1, 3, 7, 14, 30, 90]) {
          const input = Object.freeze({ mode, interval_seconds, retention_days, local_retention_days });
          const parsed = parseJobHistorySettings(input);
          expect(parsed).toEqual(input);
          expect(parsed).not.toBe(input);
        }
      }
    }
  }
});

it("rejects unsupported values, coercion and missing fields on either side of the wire", () => {
  const invalidFields = {
    mode: [undefined, null, "", "automatic", 0, false],
    interval_seconds: [undefined, null, "300", 0, -60, 30, 300.5, Infinity, NaN],
    retention_days: [undefined, null, "7", 0, -7, 2, 7.5, Infinity, NaN],
    local_retention_days: [undefined, null, "0", false, -1, 2, 0.5, Infinity, NaN],
  };
  for (const [key, values] of Object.entries(invalidFields)) {
    for (const value of values) expect(parseJobHistorySettings({ ...settings, [key]: value })).toBeUndefined();
    const missing: Record<string, unknown> = { ...settings };
    delete missing[key];
    expect(parseJobHistorySettings(missing)).toBeUndefined();
  }
});

it("rejects malformed extensions and unknown fields instead of silently dropping policy", () => {
  for (const input of [undefined, null, [], "batched", 300, true, {}, { ...settings, cleanup: true }]) {
    expect(parseJobHistorySettings(input)).toBeUndefined();
  }
});
