// Real authenticated HTTP against startTrackingServer, and the real record_fields tool on an invented text source.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {preparationTools} from '../../core/preparation/tools.js';
import type {ToolContext} from '../../core/agent/contracts.js';

test('document names are saved per account, survive restart and reject invalid input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-names-')),key=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin;
 try{
  const owner=new AccountClient(origin);await owner.signin('invented-names','invented-password-123',true);
  assert.deepEqual(await owner.request('/profile/document-names',{}),{names:[]});
  assert.deepEqual(await owner.request('/profile/document-names/save',{names:['  Lim  Mei Ling ','TAN AH KOW','TAN AH KOW']}),{names:['Lim Mei Ling','TAN AH KOW']});
  for(const names of [['L1M'],Array(9).fill('Lim'),[''],'Lim'])await assert.rejects(owner.request('/profile/document-names/save',{names}),/400/);
  await assert.rejects(owner.request('/profile/document-names',{extra:1}),/400/);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  const again=new AccountClient(origin);await again.signin('invented-names','invented-password-123');
  assert.deepEqual(await again.request('/profile/document-names',{}),{names:['Lim Mei Ling','TAN AH KOW']});
  const other=new AccountClient(origin);await other.signin('invented-other-names','invented-password-123',true);
  assert.deepEqual(await other.request('/profile/document-names',{}),{names:[]});
  assert.equal((await fetch(origin+'/profile/document-names',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('record_fields leaves a near-miss of a saved name unresolved; exact names and owner corrections pass',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-names-fields-'));const store=new EvidenceStore(dir);const ns={workspaceId:'w',accountId:'a'};
 try{
  const {artifact,source}=store.put(ns,Buffer.from('Name: LIM MBI LING\nJoint: TAN AH KOW'),'text/plain',[],{provider:'user'});
  const preparation={sources:[source!],artifactIds:[artifact.id],fields:[] as {id:string;value:string;corrected?:boolean}[]};
  const tasks={get:()=>({preparation}),update:(_id:string,fn:(t:{preparation:typeof preparation})=>void)=>fn({preparation})};
  const tool=preparationTools({taskId:'t',namespace:ns,tasks,store,sessions:{},scope:()=>({sources:[source!],destinations:[],grants:[]}),documentNames:async()=>['LIM MEI LING','TAN AH KOW']} as never,'build').find(t=>t.name==='preparation.record_fields')!;
  const ctx={...ns,callId:'c',taskId:'t',runId:'r',scope:{sources:[source!],grants:[],destinations:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true} as ToolContext;
  const cite=[{artifactId:artifact.id,sourceId:source!.id,sourceVersion:source!.sha256}];
  const near=await tool.invoke(tool.inputSchema.parse({fields:[{id:'holder',label:'Name',value:'LIM MBI LING',unresolved:false,citations:cite}]}),ctx);
  assert.equal(near.status,'failed');assert.match(String(near.error?.message),/"LIM MBI LING" is 1 letter away from "LIM MEI LING".*unresolved/);
  const exact=await tool.invoke(tool.inputSchema.parse({fields:[{id:'joint',label:'Joint holder',value:'TAN AH KOW',unresolved:false,citations:cite}]}),ctx);
  assert.equal(exact.status,'ok',JSON.stringify(exact.error));
  const blank=await tool.invoke(tool.inputSchema.parse({fields:[{id:'holder',label:'Name',value:'',unresolved:true,citations:[]}]}),ctx);
  assert.equal(blank.status,'ok');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
