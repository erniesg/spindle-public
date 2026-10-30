// Actual capture-free Root HTTP/account/IPC + production purpose controller and
// classifier. Only vendor/key waiting are fixtures; no model fees or native proof.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';
import {runTimerOnly} from '../../core/preview/timer-only.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {PurposeClassifier} from '../../core/blocking/classifier.js';
import {CallBudget} from '../../core/models/provider.js';
import {JEV_MODEL,JEV_SCOPE_REVISION,SCORE_LEVELS} from '../../core/blocking/jev.js';
import type {PurposeProcessingGrant} from '../../core/blocking/wire.js';
const response=()=>Response.json({model:JEV_MODEL,answers:{relevance_choice:{type:'choice',choice:'relevant',confidence:.99,probabilities:{relevant:.99,unrelated:.005,insufficient:.005}},relevance_score:{type:'score',score:4,confidence:.99,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[i,v])),probabilities:{0:0,1:0,2:0,3:0,4:1}},explains_concept:{type:'noul',noul:.99}},usage:{input_tokens:10,output_tokens:1}});
test('Root purpose needs account/profile and separate grant, with priority revoke and account-change fences but no timer/capture grant',async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/purpose-root-'));
 const backend=await startTrackingServer(join(directory,'account'),randomBytes(32));let modelCalls=0,keyReads=0,hold=false;
 let entered=()=>{},release=()=>{};
 const classifier=new PurposeClassifier(new CallBudget(.1,20),async()=>{keyReads++;entered();if(hold)await new Promise<void>(resolve=>{release=resolve;});return 'invented-fixture-key';},async()=>{modelCalls++;return response();});
 const host=await runTimerOnly(join(directory,'control'),true,{purposeClassifier:classifier});
 const api=async(path:string,value:unknown={})=>{const r=await fetch(host.origin+path,{method:'POST',headers:{Origin:host.origin,Authorization:'Bearer '+new URL(host.url).hash.slice(1),'Content-Type':'application/json'},body:JSON.stringify(value)});return {status:r.status,value:await r.json() as Record<string,unknown>};};
 const ipc=async(message:Record<string,unknown>)=>{
  const config=JSON.parse(await readFile(join(directory,'control/connection.json'),'utf8')) as {secret:string;ipcPath:string};
  return new Promise<Record<string,unknown>>((resolve,reject)=>{const socket=connect(config.ipcPath);let text='';socket.on('error',reject);socket.on('close',()=>reject(Error('IPC_CLOSED')));socket.setTimeout(3000,()=>socket.destroy(Error('IPC_TIMEOUT')));socket.on('connect',()=>socket.write(JSON.stringify({schema:'spindle-browser-preview/v1',secret:config.secret,...message})+'\n'));socket.on('data',data=>{text+=data;const i=text.indexOf('\n');if(i>=0){resolve(JSON.parse(text.slice(0,i)));socket.destroy();}});});
 };
 try{
  assert.equal((await api('/pomodoro/signin',{origin:backend.origin,name:'invented-purpose-a',password:'invented-only-password',register:true})).status,200);
  const state=await (await fetch(host.origin+'/state',{headers:{Authorization:'Bearer '+new URL(host.url).hash.slice(1)}})).json() as {pair:string;capture:string;pomodoroAccess:boolean};assert.equal(state.capture,'unavailable-timer-only');assert.equal(state.pomodoroAccess,false);
  assert.equal((await ipc({kind:'purpose',data:{action:'session'}})).ok,false);
  const profile=(await ipc({kind:'pair',code:state.pair})).profileToken;
  const purpose=(data:unknown,token=profile)=>ipc({kind:'purpose',profileToken:token,data});
  const session=(await purpose({action:'session'})).value as {binding:string;configured:boolean};assert.equal(session.configured,true);assert.equal(keyReads,0);
  const resource='https://gating.example/opaque',fields=['resource','purpose','title','summary','pageText'];
  const grant=async(binding:string)=>{const r=await purpose({action:'grant',binding,approved:true,resource,purpose:'Practice algebra',policyVersion:1,source:{resource,evidenceId:'static:'+'a'.repeat(64),mode:'static-resource'},fields});assert.equal(r.ok,true);return r.value as PurposeProcessingGrant;};
  const classify=(g:PurposeProcessingGrant)=>purpose({action:'classify',binding:g.binding,grantId:g.id,request:{requestId:'root-request',resource,purpose:g.purpose,policyVersion:1,expectedModelRevision:JEV_SCOPE_REVISION,expectedConsentRevision:g.revision,title:'Invented equations',summary:'Worked solution',pageText:'Invented algebra example and explanation.'}});
  let g=await grant(session.binding);assert.equal(keyReads,0);
  hold=true;let began=new Promise<void>(resolve=>{entered=resolve;});let pending=classify(g);await began;
  assert.equal((await purpose({action:'revoke',binding:g.binding},'wrong-profile')).ok,false);
  assert.equal((await purpose({action:'revoke',binding:'stale-binding'})).ok,false);assert.equal(modelCalls,0);
  assert.equal((await purpose({action:'session'})).code,'PURPOSE_BUSY');
  assert.equal((await purpose({action:'revoke',binding:g.binding})).ok,true);assert.equal((await pending).ok,false);release();assert.equal(modelCalls,0);
  hold=false;g=await grant(session.binding);const allowed=await classify(g);assert.equal(allowed.ok,true);assert.equal((allowed.value as {verdict:string}).verdict,'allow');assert.equal(modelCalls,1);
  g=await grant(session.binding);hold=true;began=new Promise<void>(resolve=>{entered=resolve;});pending=classify(g);await began;
  assert.equal((await api('/pomodoro/signin',{origin:backend.origin,name:'invented-purpose-b',password:'invented-only-password',register:true})).status,200);assert.equal((await pending).ok,false);release();assert.equal(modelCalls,1);
  assert.equal((await purpose({action:'grant',binding:session.binding,approved:true,resource,purpose:'old',policyVersion:1,source:{},fields})).code,'ACCOUNT_CHANGED');
  const b=(await purpose({action:'session'})).value as {binding:string};assert.notEqual(b.binding,session.binding);
  g=await grant(b.binding);began=new Promise<void>(resolve=>{entered=resolve;});pending=classify(g);await began;
  assert.equal((await api('/pomodoro/signout',{binding:session.binding})).status,409);assert.equal((await purpose({action:'session'})).code,'PURPOSE_BUSY');
  assert.equal((await api('/pomodoro/signout',{binding:b.binding})).status,200);assert.equal((await pending).ok,false);release();assert.equal(modelCalls,1);
 }finally{release();await host.close();await backend.close();await rm(directory,{recursive:true,force:true});}
});
