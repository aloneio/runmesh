import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import vm from "node:vm";
import {transformSync} from "esbuild";
const code=readFileSync(new URL("../apps/worker/src/ui-catalog.ts",import.meta.url),"utf8");
const context={module:{exports:{}},exports:{}};
vm.runInNewContext(transformSync(code,{loader:"ts",format:"cjs"}).code,context);
const catalog=context.module.exports.ZH_UI_TEXT;
const index=readFileSync(new URL("../apps/worker/src/index.ts",import.meta.url),"utf8");
test("literal administrator errors all have a Chinese translation",()=>{
 const missing=new Set();
 for(const call of index.matchAll(/\badminError\(([^;\n]+)/g)){
  if(index.slice(Math.max(0,call.index-12),call.index).includes("function"))continue;
  for(const match of call[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)){
   const value=JSON.parse('"'+match[1]+'"');if(/[A-Za-z]{2} /.test(value)&&!Object.hasOwn(catalog,value))missing.add(value);
  }
 }
 assert.deepEqual([...missing].sort(),[]);
});
test("authored static labels are canonical English instead of joined Chinese/English",()=>{
 const views=readdirSync(new URL("../apps/worker/src/admin/",import.meta.url)).filter(file=>file.endsWith(".ts")&&file!=="client-script.ts").map(file=>`admin/${file}`);
 for(const file of ["index.ts","history-ui.ts","admin-jobs.ts",...views]){
  let source=readFileSync(new URL(`../apps/worker/src/${file}`,import.meta.url),"utf8");
  source=source.split("function adminScript(")[0].replace(/^(?:export )?function languageSwitch\(.*$/gm,"");
  // Preserve the two pre-existing enrollment-mode descriptions in this
  // rendering-only move. They were below the old browser-script cutoff;
  // all other extracted labels are now checked rather than skipped.
  if(file==="admin/enrollment-view.ts")source=source.replace(/^  const (?:modeLabel|privilegedWarning) = .*$/gm,"");
  assert.doesNotMatch(source,/[\u4e00-\u9fff]/,file);
 }
});
test("catalog entries have nonempty string keys and translations",()=>{
 for(const [en,zh] of Object.entries(catalog)){assert.ok(en.trim().length>0);assert.equal(typeof zh,"string");assert.ok(zh.trim().length>0);}
});
