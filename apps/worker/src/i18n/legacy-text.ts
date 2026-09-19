import { formatMessage } from "./format-message.js";
import type { UiLocale } from "../contracts/locale.js";
import { ZH_UI_TEXT } from "../ui-catalog.js";

const catalog: Readonly<Record<string,string>> = Object.assign(Object.create(null), ZH_UI_TEXT);

export function localizeUiText(value: string, locale: UiLocale): string {
  if(locale === "en") return value;
  const text=value.trim();if(!text)return value;
  const direct=catalog[value]??catalog[text];if(direct!==undefined)return value.replace(text,()=>direct.trim());
  const scopes=text.split(", ");
  if(scopes.length>1 && scopes.every(part=>["Read","Write","Exec"].includes(part)))return value.replace(text,()=>scopes.map(part=>catalog[part]).join("、"));
  const count=/^(\d+) (configured|connected|days?|min|minutes?|seconds?|ms)$/.exec(text);
  // Preserve legacy digit spelling; new parameterized callers use formatMessage.
  if(count) return value.replace(text,`${count[1]} ${{configured:"已配置",connected:"已连接",day:"天",days:"天",min:"分钟",minute:"分钟",minutes:"分钟",second:"秒",seconds:"秒",ms:"毫秒"}[count[2]!]}`);
  if (text.includes(" · ")) {
    const translated=text.split(" · ").map(part=>catalog[part]??part).join(" · ");
    if(translated!==text)return value.replace(text,translated);
  }
  const title=/^(.+?)( · |: )(.+)$/.exec(text);
  if(title && catalog[title[1]!]!==undefined) return value.replace(text,catalog[title[1]!] + title[2]! + (catalog[title[3]!]??title[3]!));
  const until=/^This code is valid until ([0-9TZ:.+-]+) and can be used once\.$/.exec(text);
  if(until)return value.replace(text, () => formatMessage("enrollment.validUntil", locale, { until: until[1]! }));
  const enrollment=/^Enrollment code was created, but the temporary Runner safety lock could not be released\. Diagnostic: ([a-z_]+)\. No enrollment code was disclosed\. Regeneration does not require deleting or reinstalling the Runner\.$/.exec(text);
  if(enrollment)return value.replace(text,`注册码已创建，但临时安全隔离未能解除。诊断代码：${enrollment[1]}。未显示注册码，请勿因此删除或重装 Runner。`);
  return value;
}
