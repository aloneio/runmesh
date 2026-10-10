import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {parse} from "@babel/parser";
import { ZH_UI_TEXT } from "../apps/worker/dist/ui-catalog.js";
import { MESSAGES } from "../apps/worker/dist/i18n/messages.js";

const catalog=ZH_UI_TEXT;
const http = readdirSync(new URL("../apps/worker/src/http/", import.meta.url)).filter(file => file.endsWith(".ts"));
const administratorErrorHelpers=new Set(["adminError","adminRunnerError","adminClientError","adminUpstreamError","adminSectionError"]);
function administratorErrorMessages(source){
 const messages=[];
 function collect(argument){
  if(argument?.type==="StringLiteral")messages.push(argument.value);
  else if(argument?.type==="ConditionalExpression"){collect(argument.consequent);collect(argument.alternate);}
 }
 function visit(node){
  if(!node||typeof node!=="object")return;
  if(node.type==="CallExpression"&&node.callee.type==="Identifier"&&administratorErrorHelpers.has(node.callee.name))collect(node.arguments[1]);
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==="object")visit(value);
 }
 visit(parse(source,{sourceType:"module",plugins:["typescript"]}).program);
 return messages;
}
test("administrator error coverage reads complete static messages from every response helper",()=>{
 const source=`
  adminError(400, "Administrator error.");
  adminRunnerError(
   409,
   "Runner state changed; reload and retry."
  );
  adminClientError(404, missing ? "Client was not found." : changed ? "Client state changed." : dynamicMessage);
  adminUpstreamError(response, "Upstream unavailable.", 400, adminRunnerError);
  adminSectionError(503, "Section unavailable.", "runners");
  adminError(400, dynamicMessage);
  adminRunnerError(400, "User input: " + userInput);
  otherError(400, "Unrelated message.");
 `;
 assert.deepEqual(administratorErrorMessages(source),[
  "Administrator error.","Runner state changed; reload and retry.","Client was not found.","Client state changed.","Upstream unavailable.","Section unavailable."
 ]);
});
test("literal administrator errors all have a Chinese translation",()=>{
 const missing=new Set();
 for(const file of http){
  const source=readFileSync(new URL(`../apps/worker/src/http/${file}`,import.meta.url),"utf8");
  for(const value of administratorErrorMessages(source))if(/[A-Za-z]{2} /.test(value)&&!Object.hasOwn(catalog,value))missing.add(value);
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

test("keyed messages and legacy translation adapter are immutable and unambiguous",()=>{
 const text=readFileSync(new URL("../apps/worker/src/i18n/messages.ts",import.meta.url),"utf8");
 const ast=parse(text,{sourceType:'module',plugins:['typescript']});
 const declaration=ast.program.body.find(node=>node.type==='VariableDeclaration'&&node.declarations[0].id.name==='definitions').declarations[0];
 const keys=declaration.init.expression.properties.map(property=>{assert.equal(property.type,'ObjectProperty');assert.equal(property.computed,false);return property.key.value;});
 assert.equal(new Set(keys).size,keys.length,'Message keys must not silently override');
 assert.equal(Object.isFrozen(MESSAGES),true);assert.equal(Object.isFrozen(catalog),true);
 for(const value of Object.values(MESSAGES)) {assert.ok(Object.isFrozen(value));assert.equal(catalog[value.en],value['zh-CN']);}
 assert.equal(Object.keys(catalog).length,Object.keys(MESSAGES).length);
});
