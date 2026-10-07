export type UiLocale = "en" | "zh-CN";

/** Static labels and application data stay distinct until the locale is selected. */
export type UiTitlePart = string | { readonly data: string };
