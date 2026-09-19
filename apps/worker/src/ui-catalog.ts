import { MESSAGES } from "./i18n/messages.js";

/** Compatibility adapter for pre-keyed HTML. New UI copy belongs to messages.ts. */
const entries = Object.values(MESSAGES).map(value => [value.en, value["zh-CN"]] as const);
if (new Set(entries.map(([english]) => english)).size !== entries.length) throw new Error("duplicate_legacy_message");
export const ZH_UI_TEXT: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(entries));
