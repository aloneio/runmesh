import { localizeUiText } from "./legacy-text.js";
import { requestLocale } from "./locale.js";
import { supportedLocale } from "./locale.js";

function decodeText(value: string): string {
  const named: Readonly<Record<string,string>> = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:"\u00a0" };
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/giu, token => {
    const name=token.slice(1,-1);
    if (name[0] !== "#") return named[name] ?? token;
    const point = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2),16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : token;
  });
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
