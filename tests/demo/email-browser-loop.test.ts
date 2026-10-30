import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentProvider} from '../../core/agent/contracts.js';
import {runEmailBrowserLoop} from '../../tools/demo-email-browser-loop.js';
import type {BrowserLoopInput} from '../../tools/demo-browser-loop.js';

const executablePath=process.env.SPINDLE_WEB_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome';
interface View {snapshotRef:string;fields:{ref:string;name:string;type:string}[];actions:{ref:string}[]}
function fixtureProvider(readMail:boolean):AgentProvider{return {id:'scripted-email-browser-NOT-model',async next(t){
 if(readMail&&!t.observations.some(o=>(o.data as {message?:unknown})?.message))return {kind:'tool',name:'mail.read',args:{messageId:t.sourceEvent.messageId}};
 const input=JSON.parse(t.requestedOutcome) as BrowserLoopInput,view=t.observations.map(o=>o.data as View).find(v=>v?.snapshotRef&&v.fields);
 if(!view)return {kind:'tool',name:'browser.inspect',args:{}};
 const field=view.fields.find(f=>!t.decisions.some(d=>d.kind==='tool'&&['browser.fill','browser.upload'].includes(d.name)&&(d.args as {fieldRef?:string}).fieldRef===f.ref));
 if(field){const args={snapshotRef:view.snapshotRef,fieldRef:field.ref};if(field.type==='file')return {kind:'tool',name:'browser.upload',args:{...args,artifactId:input.attachments.find(a=>a.field===field.name)!.artifactId}};
  return {kind:'tool',name:'browser.fill',args:{...args,value:input.fields.find(v=>v.name===field.name)!.value}};}
 if(!t.decisions.some(d=>d.kind==='tool'&&d.name==='browser.submit'))return {kind:'tool',name:'browser.submit',args:{snapshotRef:view.snapshotRef,actionRef:view.actions[0]!.ref}};
 if((t.observations.at(-1)?.data as {state?:string})?.state!=='verified')return {kind:'tool',name:'browser.verify_submission',args:{}};
 return {kind:'ready',result:'Observed actual email source and persisted fictional receipt.'};
}};}

for(const readMail of [true,false])test(`email/browser machinery requires actual model-observed mail, readMail=${readMail}`,async()=>{
 const scratch=process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch/spindle-demo-loops';mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'email-browser-test-'));
 try{
  const result=await runEmailBrowserLoop({outputDir:join(root,'run'),executablePath,approveFictionalSubmit:true,recordVideo:false,provider:{kind:'scripted-test',provider:fixtureProvider(readMail)}});
  assert.equal(result.accepted,readMail,JSON.stringify(result));assert.equal(result.sameAdmittedTask,true);assert.equal(result.browser.accepted,true);assert.equal(result.browser.recordCount,1);
  assert.equal(result.modelObservedMail,readMail);assert.equal(result.mailReadBeforeWrite,readMail);assert.equal(result.admission,'inserted');
  assert.ok(result.fixtureRequests.filter(r=>r.method==='POST').every(r=>r.path==='/token'));
  const session=JSON.parse(readFileSync(join(root,'run','browser','visible-session.json'),'utf8'));
  assert.equal(session.taskId,result.browser.taskId);assert.ok(session.input.includes('mail.read'));assert.equal(session.modelCalls.length,0);
  if(readMail)assert.ok(session.results.some((r:{data?:{message?:{text:string}}})=>r.data?.message?.text.includes('Mira Example')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
