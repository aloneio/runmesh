import { ZH_UI_TEXT } from "./ui-catalog.js";
const catalog: Readonly<Record<string,string>> = Object.assign(Object.create(null), ZH_UI_TEXT);
export type UiLocale = "en" | "zh-CN";
export function requestLocale(request: Request): UiLocale {
  const query=new URL(request.url).searchParams.get("lang");
  if (query === "en") return "en";
  if (query === "zh" || query === "zh-CN") return "zh-CN";
  const cookie=/(?:^|;\s*)runmesh_lang=(zh-CN|en)(?:;|$)/.exec(request.headers.get("cookie")??"");
  if (cookie) return cookie[1] as UiLocale;
  const languages=(request.headers.get("accept-language")??"").split(",").map((part,index)=>{
    const [language,...options]=part.trim().split(";");const quality=options.find(v=>v.trim().startsWith("q="));
    return {language:language?.toLowerCase()??"",quality:quality===undefined?1:Number(quality.trim().slice(2)),index};
  }).filter(v=>v.quality>0 && Number.isFinite(v.quality)).sort((a,b)=>b.quality-a.quality||a.index-b.index);
  for(const value of languages){if(value.language.startsWith("zh"))return "zh-CN";if(value.language.startsWith("en"))return "en";}
  return "en";
}
function decodeText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#039|#x27);/g, token => ({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'","&#39;":"'","&#039;":"'","&#x27;":"'"})[token] ?? token);
}
export function localizeUiText(value: string, locale: UiLocale): string {
  if(locale === "en") return value;
  const text=value.trim();if(!text)return value;
  const direct=catalog[value]??catalog[text];if(direct!==undefined)return value.replace(text,direct.trim());
  const count=/^(\d+) (configured|connected|days?|min|minutes?|seconds?)$/.exec(text);
  if(count) return value.replace(text,`${count[1]} ${{configured:"已配置",connected:"已连接",day:"天",days:"天",min:"分钟",minute:"分钟",minutes:"分钟",second:"秒",seconds:"秒"}[count[2]!]}`);
  if (text.includes(" · ")) {
    const translated=text.split(" · ").map(part=>catalog[part]??part).join(" · ");
    if(translated!==text)return value.replace(text,translated);
  }
  const title=/^(.+?)( · |: )(.+)$/.exec(text);
  if(title && catalog[title[1]!]!==undefined) return value.replace(text,catalog[title[1]!] + title[2]! + (catalog[title[3]!]??title[3]!));
  const until=/^This code is valid until ([0-9TZ:.+-]+) and can be used once\.$/.exec(text);
  if(until)return value.replace(text,`此注册码有效期至 ${until[1]}，且仅可使用一次。`);
  const enrollment=/^Enrollment code was created, but the temporary Runner safety lock could not be released\. Diagnostic: ([a-z_]+)\. No enrollment code was disclosed\. Regeneration does not require deleting or reinstalling the Runner\.$/.exec(text);
  if(enrollment)return value.replace(text,`注册码已创建，但临时安全隔离未能解除。诊断代码：${enrollment[1]}。未显示注册码，请勿因此删除或重装 Runner。`);
  return value;
}

/** Render one locale before first paint. Never translate code, logs, form
 * values or explicitly marked user labels; no browser-side retranslations. */
export function localizeHtmlResponse(request: Request, response: Response): Response {
  if(!response.body || !response.headers.get("content-type")?.includes("text/html"))return response;
  const locale=requestLocale(request);
  let excluded=0, textBuffer="";
  const skipTags=new Set(["script","style","pre","code","textarea","svg"]);
  const rewriter=new HTMLRewriter().on("*",{
    element(element){
      const skip=skipTags.has(element.tagName)||element.hasAttribute("data-no-i18n");
      if(skip && !["input","img","br","hr","meta","link"].includes(element.tagName)){excluded++;element.onEndTag(()=>{excluded--;});}
      if(!excluded)for(const name of ["aria-label","alt","placeholder","title"]){const old=element.getAttribute(name);if(old!==null){const next=localizeUiText(decodeText(old),locale);if(next!==old)element.setAttribute(name,next);}}
      if(element.tagName === "html")element.setAttribute("lang",locale);
    }
  }).on("html",{
    text(chunk){
      if(excluded)return;
      textBuffer+=chunk.text;
      if(!chunk.lastInTextNode){chunk.remove();return;}
      const raw=textBuffer, decoded=decodeText(raw), result=localizeUiText(decoded,locale);textBuffer="";
      // HTMLRewriter text chunks retain entity escapes. Preserve unmodified
      // source text byte-for-byte; translations are escaped as fresh text.
      if(result===decoded)chunk.replace(raw,{html:true});else chunk.replace(result);
    }
  });
  const headers=new Headers(response.headers);
  headers.set("content-language",locale);headers.set("cache-control","no-store");headers.delete("content-length");
  const vary=new Set((headers.get("vary")??"").split(",").map(s=>s.trim()).filter(Boolean));for(const item of ["Cookie","Accept-Language"])vary.add(item);headers.set("vary",[...vary].join(", "));
  return rewriter.transform(new Response(response.body,{status:response.status,statusText:response.statusText,headers}));
}
