import { ZH_UI_TEXT } from "./ui-catalog.js";
const catalog: Readonly<Record<string,string>> = Object.assign(Object.create(null), ZH_UI_TEXT);
export type UiLocale = "en" | "zh-CN";
/** Only the two supported interface languages are selected. Region/script
 * variants fall back to their supported base, not a new translation bundle. */
function supportedLocale(value: string | null): UiLocale | undefined {
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
function decodeText(value: string): string {
  const named: Readonly<Record<string,string>> = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:"\u00a0" };
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/giu, token => {
    const name=token.slice(1,-1);
    if (name[0] !== "#") return named[name] ?? token;
    const point = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2),16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : token;
  });
}
export function localizeUiText(value: string, locale: UiLocale): string {
  if(locale === "en") return value;
  const text=value.trim();if(!text)return value;
  const direct=catalog[value]??catalog[text];if(direct!==undefined)return value.replace(text,()=>direct.trim());
  const scopes=text.split(", ");
  if(scopes.length>1 && scopes.every(part=>["Read","Write","Exec"].includes(part)))return value.replace(text,()=>scopes.map(part=>catalog[part]).join("、"));
  const count=/^(\d+) (configured|connected|days?|min|minutes?|seconds?|ms)$/.exec(text);
  if(count) return value.replace(text,`${count[1]} ${{configured:"已配置",connected:"已连接",day:"天",days:"天",min:"分钟",minute:"分钟",minutes:"分钟",second:"秒",seconds:"秒",ms:"毫秒"}[count[2]!]}`);
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
  let excluded=0, textBuffer="", oversizedText=false;
  const skipTags=new Set(["script","style","pre","code","textarea","svg"]);
  const voidTags=new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const rewriter=new HTMLRewriter().on("*",{
    element(element){
      const skip=skipTags.has(element.tagName)||element.hasAttribute("data-no-i18n")||element.getAttribute("translate")?.toLowerCase()==="no";
      if(skip && !voidTags.has(element.tagName)){excluded++;element.onEndTag(()=>{excluded--;});}
      if(!excluded && !skip)for(const name of ["aria-label","alt","placeholder","title"]){const old=element.getAttribute(name);if(old!==null){const next=localizeUiText(decodeText(old),locale);if(next!==old)element.setAttribute(name,next);}}
      if(element.tagName === "html")element.setAttribute("lang",locale);
    }
  }).on("html",{
    text(chunk){
      if(excluded)return;
      // Long application text is not a translation key. Preserve it rather
      // than accumulating an unbounded streaming node in the locale layer.
      if(oversizedText){if(chunk.lastInTextNode)oversizedText=false;return;}
      textBuffer+=chunk.text;
      if(textBuffer.length > 65536){chunk.replace(textBuffer,{html:true});textBuffer="";oversizedText=!chunk.lastInTextNode;return;}
      if(!chunk.lastInTextNode){chunk.remove();return;}
      const raw=textBuffer, decoded=decodeText(raw), result=localizeUiText(decoded,locale);textBuffer="";
      // HTMLRewriter text chunks retain entity escapes. Preserve unmodified
      // source text byte-for-byte; translations are escaped as fresh text.
      if(result===decoded)chunk.replace(raw,{html:true});else chunk.replace(result);
    }
  });
  const headers=new Headers(response.headers);
  if(supportedLocale(new URL(request.url).searchParams.get("lang")) !== undefined){
    headers.append("set-cookie",`runmesh_lang=${locale}; Max-Age=31536000; Path=/; SameSite=Lax${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`);
  }
  headers.set("content-language",locale);headers.set("cache-control","no-store");headers.delete("content-length");
  const vary=new Set((headers.get("vary")??"").split(",").map(s=>s.trim()).filter(Boolean));for(const item of ["Cookie","Accept-Language"])vary.add(item);headers.set("vary",[...vary].join(", "));
  return rewriter.transform(new Response(response.body,{status:response.status,statusText:response.statusText,headers}));
}
