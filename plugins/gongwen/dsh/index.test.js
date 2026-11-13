import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Intercept subprocesses and home before importing the plugin: no real user writes or Python launch.
const home=mkdtempSync(join(tmpdir(),'gongwen-bridge-test-'));
mkdirSync(join(home,'.gongwen-skill'));
writeFileSync(join(home,'.gongwen-skill/dsh-config.json'),JSON.stringify({default_doc_type:'notice',body:{font:'测试字体',size:'16pt'},page_setup:{margins:{top:'3cm'}}}));
const calls=[];
let failure=false;
let p0Failure=false;
globalThis.__gongwenSpawn=(executable,args,options)=>{
 calls.push({executable,args,options});
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 queueMicrotask(()=>{
  const command=args[2];const get=name=>args[args.indexOf('--'+name)+1];const output=args.includes('--output')?get('output'):join(home,'default.docx');
  let result;
  if(command==='generate'){writeFileSync(output,'generated');result={output};}
  else if(command==='draft'||command==='optimize'){
   writeFileSync(output,'verified');
   const verify={output,verify_executed:!failure,verified:!failure&&!p0Failure,verify_passed:!failure&&!p0Failure,verify_p0:p0Failure?1:0,verify_p1:2,verify_p2:1};
   result=command==='draft'?{output,optimize:verify}:verify;
  }else if(command==='check'){result=[];}
  else result={output};
  child.stdout.emit('data',Buffer.from(JSON.stringify(result)));child.emit('close',failure||p0Failure?1:0);
 });
 return child;
};
registerHooks({
 resolve(s,c,n){if(s==='@deepseek-ai/dsh-tools')return {url:'test:tools',shortCircuit:true};return n(s,c);},
 load(url,c,n){
  if(url==='test:tools')return {format:'module',source:'export const defineTool=x=>x;',shortCircuit:true};
  if(url.endsWith('/dsh/index.js')){
   let source=readFileSync(new URL(url),'utf8');
   source=source.replace(/import \{ spawn \} from "node:child_process";/,'const spawn=globalThis.__gongwenSpawn;');
   source=source.replace(/import \{ homedir, tmpdir \} from "node:os";/,`import {tmpdir} from 'node:os';const homedir=()=>${JSON.stringify(home)};`);
   return {format:'module',source,shortCircuit:true};
  }
  return n(url,c);
 }
});
const plugin=await import('./index.js');
const out=join(home,'out.docx');
test('DSH md2docx enters verified draft and preserves layout, config and array arguments',async()=>{
 calls.length=0;
 const result=await plugin.call({}, {command:'md2docx',input:'draft.md',output:out,'doc-type':'report',layout:'layout.json',recipients:['甲单位','乙单位']});
 assert.equal(calls[0].args[2],'draft');assert.ok(calls[0].args.includes('--verify'));assert.ok(calls[0].args.includes('--json'));
 assert.equal(result.delivery.stage,'verified');assert.equal(result.delivery.issues.P1,2);
 const args=calls[0].args;assert.equal(args[args.indexOf('--layout')+1],'layout.json');
 assert.equal(args[args.indexOf('--doc-type')+1],'report');assert.equal(args[args.indexOf('--default-doc-type')+1],'notice');
 assert.deepEqual(args.slice(args.indexOf('--recipients')+1,args.indexOf('--recipients')+3),['甲单位','乙单位']);
 const config=JSON.parse(args[args.indexOf('--config-overrides')+1]);assert.equal(config.body.font,'测试字体');
});
test('formal delivery cannot skip verification and failure is not a verified success',async()=>{
 const count=calls.length;
 assert.equal((await plugin.call({}, {command:'draft',input:'draft.md','no-verify':true})).success,false);
 assert.equal(calls.length,count);
 failure=true;
 try{const result=await plugin.call({}, {command:'draft',input:'draft.md',output:out});assert.equal(result.success,false);assert.equal(result.delivery.verified,false);assert.equal(result.delivery.stage,'verification_failed');}finally{failure=false;}
});
test('JSON generation is followed by optimize apply and final verification',async()=>{
 calls.length=0;
 const result=await plugin.call({}, {command:'generate',input:'model.json',output:out,'doc-type':'report',layout:'layout.json'});
 assert.deepEqual(calls.map(x=>x.args[2]),['generate','optimize']);assert.ok(calls[1].args.includes('--apply'));assert.ok(calls[1].args.includes('--verify'));
 assert.equal(result.delivery.stage,'verified');
});
test('template and optimize preview never claim finished document; post-layout checks run',async()=>{
 assert.equal((await plugin.call({}, {command:'template',type:'notice',output:out})).delivery.stage,'template');
 assert.equal((await plugin.call({}, {command:'optimize',input:out})).delivery.stage,'preview');
 calls.length=0;
 const result=await plugin.call({}, {command:'header',input:out,'org-name':'测试机关'});
 assert.deepEqual(calls.map(x=>x.args[2]),['header','check']);assert.equal(result.delivery.verified,true);
});
test('named learned template selects the same rule for generation and verification',async()=>{
 calls.length=0;
 const result=await plugin.call({}, {command:'draft',input:'draft.md',output:out,template:'单位报告模板'});
 const args=calls[0].args;
 assert.equal(args[args.indexOf('--doc-type')+1],'单位报告模板');assert.ok(!args.includes('--template'));
 assert.equal(result.delivery.verified,true);
});
test('partial layout overrides retain other nested user settings',async()=>{
 calls.length=0;
 await plugin.call({}, {command:'draft',input:'draft.md',output:out,'config-overrides':JSON.stringify({page_setup:{margins:{bottom:'4cm'}},body:{size:'18pt'}})});
 const args=calls[0].args;const config=JSON.parse(args[args.indexOf('--config-overrides')+1]);
 assert.deepEqual(config.page_setup.margins,{top:'3cm',bottom:'4cm'});assert.equal(config.body.font,'测试字体');assert.equal(config.body.size,'18pt');
});
test('P0 validation failure is reported as needs_revision with counts',async()=>{
 p0Failure=true;
 try{const result=await plugin.call({}, {command:'draft',input:'draft.md',output:out});assert.equal(result.success,false);assert.equal(result.delivery.stage,'needs_revision');assert.equal(result.delivery.issues.P0,1);}finally{p0Failure=false;}
});
test('contact note reaches CLI and DSH generation disables automatic AI declaration',async()=>{
 calls.length=0;
 await plugin.call({}, {command:'draft',input:'draft.md',output:out,note:'联系人：张某；电话：123456'});
 const args=calls[0].args;
 assert.equal(args[args.indexOf('--note')+1],'联系人：张某；电话：123456');
 assert.ok(args.includes('--no-ai-declaration'));
 calls.length=0;
 await plugin.call({}, {command:'optimize',input:out,output:out,apply:true});
 assert.ok(calls[0].args.includes('--remove-ai-declaration'));
});
test.after(()=>{rmSync(home,{recursive:true,force:true});delete globalThis.__gongwenSpawn;});
