import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import { ZH_UI_TEXT } from "../apps/worker/dist/ui-catalog.js";
import { MESSAGES } from "../apps/worker/dist/i18n/messages.js";

const code=readFileSync(new URL("../apps/worker/src/ui-catalog.ts",import.meta.url),"utf8");
const catalog=ZH_UI_TEXT;
const http = readdirSync(new URL("../apps/worker/src/http/", import.meta.url)).filter(file => file.endsWith(".ts"));
const index=http.map(file => readFileSync(new URL(`../apps/worker/src/http/${file}`, import.meta.url),"utf8")).join("\n");
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
  assert.doesNotMatch(source,/[\u4e00-\u9fff]/,file);
 }
});
test("catalog entries have nonempty string keys and translations",()=>{
 for(const [en,zh] of Object.entries(catalog)){assert.ok(en.trim().length>0);assert.equal(typeof zh,"string");assert.ok(zh.trim().length>0);}
});

test("keyed messages and legacy translation adapter are immutable and unambiguous",async()=>{
 const {parse}=await import('@babel/parser');
 const text=readFileSync(new URL("../apps/worker/src/i18n/messages.ts",import.meta.url),"utf8");
 const ast=parse(text,{sourceType:'module',plugins:['typescript']});
 const declaration=ast.program.body.find(node=>node.type==='VariableDeclaration'&&node.declarations[0].id.name==='definitions').declarations[0];
 const keys=declaration.init.expression.properties.map(property=>{assert.equal(property.type,'ObjectProperty');assert.equal(property.computed,false);return property.key.value;});
 assert.equal(new Set(keys).size,keys.length,'Message keys must not silently override');
 assert.equal(Object.isFrozen(MESSAGES),true);assert.equal(Object.isFrozen(catalog),true);
 for(const value of Object.values(MESSAGES)) {assert.ok(Object.isFrozen(value));assert.equal(catalog[value.en],value['zh-CN']);}
 assert.equal(Object.keys(catalog).length,Object.keys(MESSAGES).length);
 assert.ok(code.includes('Object.freeze(Object.fromEntries(entries))'));
});
