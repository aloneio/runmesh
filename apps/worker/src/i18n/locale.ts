import type { UiLocale } from "../contracts/locale.js";

/** Only the two supported interface languages are selected. Region/script
 * variants fall back to their supported base, not a new translation bundle. */
export function supportedLocale(value: string | null): UiLocale | undefined {
  const match = /^(en|zh)(?:-[a-z0-9]{2,8})*$/iu.exec(value ?? "");
  return match === null ? undefined : match[1]!.toLowerCase() === "zh" ? "zh-CN" : "en";
}

export function requestLocale(request: Request): UiLocale {
  const query = supportedLocale(new URL(request.url).searchParams.get("lang"));
  if (query !== undefined) return query;
  const cookie = /(?:^|;\s*)runmesh_lang=(zh-CN|en)(?:;|$)/u.exec(request.headers.get("cookie") ?? "");
  if (cookie) return cookie[1] as UiLocale;
  const languages = (request.headers.get("accept-language") ?? "").slice(0,8192).split(",").slice(0,64).map((part,index) => {
    const [language,...options] = part.trim().split(";");
    const quality = options.length === 0 ? "1" : options.length === 1 ? /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu.exec(options[0]!.trim())?.[1] : undefined;
    return { locale: supportedLocale(language?.trim() ?? null), quality: quality === undefined ? 0 : Number(quality), index };
  }).filter(value => value.locale !== undefined && value.quality > 0).sort((a,b) => b.quality-a.quality || a.index-b.index);
  return languages[0]?.locale ?? "en";
}
