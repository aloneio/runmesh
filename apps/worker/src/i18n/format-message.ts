import type { UiLocale } from "../contracts/locale.js";
export interface MessageParameters {
  "count.configured": { readonly count: number };
  "count.connected": { readonly count: number };
  "duration.days": { readonly count: number };
  "duration.minutes": { readonly count: number };
  "duration.seconds": { readonly count: number };
  "duration.milliseconds": { readonly count: number };
  "enrollment.validUntil": { readonly until: string };
}
const formats = {
  "count.configured": { parameter: "count", en: "{count} configured", "zh-CN": "{count} 已配置" },
  "count.connected": { parameter: "count", en: "{count} connected", "zh-CN": "{count} 已连接" },
  "duration.days": { parameter: "count", en: "{count} days", "zh-CN": "{count} 天" },
  "duration.minutes": { parameter: "count", en: "{count} minutes", "zh-CN": "{count} 分钟" },
  "duration.seconds": { parameter: "count", en: "{count} seconds", "zh-CN": "{count} 秒" },
  "duration.milliseconds": { parameter: "count", en: "{count} ms", "zh-CN": "{count} 毫秒" },
  "enrollment.validUntil": { parameter: "until", en: "This code is valid until {until} and can be used once.", "zh-CN": "此注册码有效期至 {until}，且仅可使用一次。" },
} as const satisfies Record<keyof MessageParameters, { parameter: string; en: string; "zh-CN": string }>;

/** Parameters stay opaque plain text: no HTML interpretation or recursive translation. */
export function formatMessage<Key extends keyof MessageParameters>(key: Key, locale: UiLocale, parameters: MessageParameters[Key]): string {
  if (!Object.hasOwn(formats, key) || (locale !== "en" && locale !== "zh-CN")) throw new Error("invalid_ui_message");
  const format = formats[key];
  if (parameters === null || typeof parameters !== "object") throw new Error("invalid_message_parameters");
  const entries = Object.entries(parameters);
  if (entries.length !== 1 || entries[0]![0] !== format.parameter) throw new Error("invalid_message_parameters");
  const value: unknown = entries[0]![1];
  if (format.parameter === "count" ? typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    : typeof value !== "string" || value.length > 4096) throw new Error("invalid_message_parameters");
  const template = format[locale];
  const plain = locale === "en" && value === 1 && ["duration.days", "duration.minutes", "duration.seconds"].includes(key) ? template.slice(0, -1) : template;
  return plain.split(`{${format.parameter}}`).join(String(value));
}
