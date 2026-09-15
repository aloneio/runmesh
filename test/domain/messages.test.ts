import { localizeUiText } from "../../apps/worker/src/i18n/legacy-text.js";
import { expect, it } from "vitest";
import { message, MESSAGES } from "../../apps/worker/src/i18n/messages.js";
import { formatMessage } from "../../apps/worker/src/i18n/format-message.js";
it("system copy uses stable keys and a deeply immutable bilingual catalogue", () => {
  expect(message("action.delete", "en")).toBe("Delete");
  expect(message("action.delete", "zh-CN")).toBe("删除");
  expect(Object.isFrozen(MESSAGES)).toBe(true);
  expect(Object.values(MESSAGES).every(value => Object.isFrozen(value))).toBe(true);
});
it("opaque caller text is not a system key", () => {
  // @ts-expect-error Human-readable input is not a MessageKey.
  expect(() => message("Delete", "en")).toThrow("invalid_ui_message");
});
it("formatted message arguments remain literal text, including dollar substitutions", () => {
  const until = "Delete <$&> {count}";
  expect(formatMessage("enrollment.validUntil", "en", { until })).toBe(`This code is valid until ${until} and can be used once.`);
  expect(formatMessage("enrollment.validUntil", "zh-CN", { until })).toContain(until);
  expect(formatMessage("count.connected", "en", { count: 3 })).toBe("3 connected");
  expect(formatMessage("duration.days", "en", { count: 1 })).toBe("1 day");
});
it("unknown, missing or malformed format parameters fail instead of silently interpolating", () => {
  expect(() => formatMessage("count.connected", "en", { count: -1 })).toThrow();
  expect(() => formatMessage("count.connected", "en", { count: Infinity })).toThrow();
  // @ts-expect-error Message parameters are tied to the selected key.
  expect(() => formatMessage("enrollment.validUntil", "en", { count: 2 })).toThrow();
  // @ts-expect-error Extra parameters are not silently accepted.
  expect(() => formatMessage("count.connected", "en", { count: 2, until: "x" })).toThrow();
});

it("the compatibility adapter preserves leading zeros and large display counts", () => {
  expect(localizeUiText("0002 configured", "zh-CN")).toBe("0002 已配置");
  expect(localizeUiText("999999999999999999999 connected", "zh-CN")).toBe("999999999999999999999 已连接");
});
