// Real explicit operator CLI and HTTP ingress; invented account/model transport only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {EvidenceStore} from '../../core/evidence/store.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
test('trusted-module assistant CLI provides a usable automatically learning path and shuts down its stores',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'spindle-memory-cli-')),modulePath=join(root,'operator.mjs');
 const appModule=pathToFileURL(resolve('build/core/memory/application.js')).href,accountModule=pathToFileURL(resolve('build/core/account/client.js')).href;
 writeFileSync(modulePath,`import {createUserMemoryApplication} from ${JSON.stringify(appModule)};
 import {AccountClient} from ${JSON.stringify(accountModule)};
 export function createUserMemory(options){
 const account=new AccountClient('http://127.0.0.1:9999',async(input)=>{
 const path=new URL(String(input)).pathname;
 if(path==='/signin')return Response.json({csrf:'c'.repeat(64)},{headers:{'set-cookie':'spindle_session='+ 'd'.repeat(64)}});
 if(path==='/session')return Response.json({account:{id:'12345678-1234-1234-1234-123456789abc',name:'sample'},csrf:'c'.repeat(64)});
 return Response.json({});});
 const provider={id:'scripted-cli-not-model-quality',async next(task){return task.observations.length?{kind:'ready',result:'done'}:{kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}};}};
 return createUserMemoryApplication({...options,account,provider});}
 `);
 const child=spawn(process.execPath,['build/core/assistant/main.js',join(root,'agents.sqlite'),'workspace','task-account',join(root,'context')],{env:{...process.env,SPINDLE_USER_MEMORY_MODULE:modulePath},stdio:['ignore','pipe','pipe']});
 const exit=once(child,'exit');let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const url=await new Promise<URL>((resolve,reject)=>{let stdout='';timer=setTimeout(()=>reject(Error('CLI_START_TIMEOUT')),10000);child.stdout.on('data',chunk=>{stdout+=String(chunk);const match=/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/.exec(stdout);if(match){clearTimeout(timer);resolve(new URL(match[0]));}});child.once('error',reject);child.once('exit',()=>reject(Error('CLI_EXITED_BEFORE_READY')));});
  const headers={Authorization:`Bearer ${url.hash.slice(1)}`,Origin:url.origin,'Content-Type':'application/json'};
  const post=async(body:unknown)=>{const response=await fetch(url.origin+'/api/user-memory',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);};
  await post({action:'signin',name:'sample',password:'invented'});await post({action:'configure',conversation:true,activity:false,processing:true,sync:false});await post({action:'conversation',text:'I prefer tea'});
  let learned=false;for(let i=0;i<40;i++){const response=await fetch(url.origin+'/api/user-memory',{headers});const state=await response.json() as {entries?:Array<{origin:string;value:string}>};if(state.entries?.some(e=>e.origin==='inferred'&&e.value==='I prefer tea.')){learned=true;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(learned,true);
  child.kill('SIGTERM');const [code]=await exit;assert.equal(code,0);
  const evidence=new EvidenceStore(join(root,'context'));try{const store=new UserMemoryStore(evidence.db);assert.equal(store.entries({workspaceId:'workspace',accountId:'12345678-1234-1234-1234-123456789abc'})[0].value,'I prefer tea.');}finally{evidence.close();}
 }finally{if(timer)clearTimeout(timer);if(child.exitCode===null){child.kill('SIGKILL');await exit;}rmSync(root,{recursive:true,force:true});}
});
