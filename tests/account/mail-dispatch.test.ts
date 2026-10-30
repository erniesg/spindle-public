import {test} from 'node:test';import assert from 'node:assert/strict';
import {MailService} from '../../core/mail/service.js';import {mailFixture} from './mail-fixture.js';import {SharedGoogle} from '../../core/tracking/google.js';import {EncryptedStore} from '../../core/tracking/store.js';

// Copied/inverted REVIEW3 scheduling: instrument the REAL final encrypted auth
// transaction, not an outer source fence or a replacement auth/transport.
for(const action of ['messages.send','drafts.create','drafts.send'] as const)test('source correction during final encrypted auth wait prevents '+action,async()=>{
 const originalBinding=SharedGoogle.prototype.mailBinding,originalTransaction=EncryptedStore.prototype.transaction;
 let path:string|undefined,armed=false,injected=false,change:()=>unknown=()=>{};let injectionStack='';
 const target=action==='messages.send'?'/messages/send':action==='drafts.create'?'/drafts':'/drafts/send';
 SharedGoogle.prototype.mailBinding=async function(...args){const b:any=await originalBinding.apply(this,args),name=b.guardedHttp?'guardedHttp':'http',http=b[name];return {...b,[name]:(...input:any[])=>{path=input[1]?.method==='POST'?new URL(String(input[0])).pathname:undefined;try{return http(...input);}finally{path=undefined;}}};};
 EncryptedStore.prototype.transaction=function(this:EncryptedStore<any>,...args:Parameters<typeof originalTransaction>){const stack=new Error().stack??'',hit=armed&&!injected&&path?.endsWith(target);const p=originalTransaction.apply(this,args);if(!hit)return p;injected=true;injectionStack=stack;return p.then(result=>{change();return result;});} as typeof originalTransaction;
 const f=await mailFixture();try{
  const source=f.prepared();change=source.change;
  const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented email with selected prepared PDF',requestId:'final-auth-'+action.replace('.','-'),processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any;
  const ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;f.setCompose(true);const flow=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(flow.authorizationUrl);
  if(action==='drafts.send')await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'prior-publication'});
  armed=true;const result=await f.client.mailAction(action==='drafts.create'?'publish':'send',{taskId:admitted.taskId,draft,requestId:'guarded-action'}) as any;
  assert.equal(injected,true,'must reach actual final binding auth transaction');assert.match(injectionStack,/tracking\/google.js/);
  assert.equal(result.source.current,false);assert.equal(result.state,'blocked');
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith(target)).length,0,'no stale MIME may reach raw Google HTTP');
  // Conservative intent holds are deliberately retained, not safe retry proof.
  assert.equal(action==='drafts.create'?result.drafts[0].publish.state:result.drafts[0].send.state,'uncertain');
  await assert.rejects(f.client.mailAction('edit',{taskId:admitted.taskId,draft,content:(await f.client.mailAction('draft',{taskId:admitted.taskId,draft}) as any).content,attachmentIds:[],requestId:'cannot-clear-unknown'}),/RECONCILIATION/);
  const observed=await f.client.mailAction('reconcile',{taskId:admitted.taskId,draft}) as any;assert.equal(action==='drafts.create'?observed.drafts[0].publish.state:observed.drafts[0].send.state,'uncertain');
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith(target)).length,0);assert.equal(f.counts().modelCalls,2);
 }finally{SharedGoogle.prototype.mailBinding=originalBinding;EncryptedStore.prototype.transaction=originalTransaction;await f.close();}
});

test('source correction after send POST keeps the uncertain intent and cannot retry',async()=>{
 let change:()=>unknown=()=>{},armed=false;const f=await mailFixture({onGoogle:call=>{if(armed&&call.method==='POST'&&call.path.endsWith('/messages/send')){armed=false;change();}}});
 try{const source=f.prepared();change=source.change;const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented mail',requestId:'post-send',processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;
  f.setCompose(true);const flow=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(flow.authorizationUrl);armed=true;
  const result=await f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'actual-send'}) as any;assert.equal(armed,false);assert.equal(result.source.current,false);assert.equal(result.drafts[0].send.state,'uncertain');assert.equal(result.drafts[0].send.code,'MAIL_DISPATCH_UNCERTAIN');assert.ok(result.drafts[0].send.intentId);
  await assert.rejects(f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'no-second-send'}),/SOURCE_CHANGED|RECONCILIATION/);
  const observed=await f.client.mailAction('reconcile',{taskId:admitted.taskId,draft}) as any;assert.equal(observed.drafts[0].send.state,'uncertain');assert.equal(observed.drafts[0].send.intentId,result.drafts[0].send.intentId);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/messages/send')).length,1);
 }finally{await f.close();}
});

test('source correction after the final async model check cannot cross raw model dispatch',async()=>{
 // Test-only scheduling after the REAL bound async check resolves to its caller.
 // Source/model auth checks and production transport remain unmodified.
 const prototype=MailService.prototype as any,original=prototype.assertModelCurrent;let armed=false,injected=false,change:()=>unknown=()=>{};
 prototype.assertModelCurrent=function(...args:any[]){const fromTransport=new Error().stack?.includes('at transport (');return original.apply(this,args).then((result:unknown)=>{if(armed&&!injected&&fromTransport){injected=true;change();}return result;});};
 const f=await mailFixture();try{const source=f.prepared();change=source.change;armed=true;
  const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented email',requestId:'model-dispatch-source',processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any,result=await f.until(admitted.taskId);
  assert.equal(injected,true,'reach actual startup model transport async bound check');assert.equal(result.source.current,false);assert.equal(result.state,'blocked');assert.equal(f.counts().modelCalls,0);
 }finally{prototype.assertModelCurrent=original;await f.close();}
});

test('post-dispatch source correction retains unknown and known publication ID, never permits another POST',async()=>{
 let change:()=>unknown=()=>{},armed=false;const f=await mailFixture({onGoogle:call=>{if(armed&&call.method==='GET'&&call.path.includes('/drafts/draft-')){armed=false;change();}}});
 try{const source=f.prepared();change=source.change;const admitted=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented mail',requestId:'post-dispatch',processingConsent:true,sourceTaskId:source.taskId,attachmentIds:[source.artifactId]}) as any,ready=await f.until(admitted.taskId),draft=ready.drafts[0].draft;
  f.setCompose(true);const flow=await f.client.authorizeGoogleMail(f.flow.connectionId);await f.callback(flow.authorizationUrl);armed=true;
  const result=await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'actual-publication'}) as any;
  assert.equal(armed,false);assert.equal(result.source.current,false);assert.equal(result.drafts[0].publish.state,'uncertain');assert.equal(result.drafts[0].publish.providerDraftId,'draft-1');assert.equal(f.drafts.size,1);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/drafts')).length,1);
  await assert.rejects(f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'no-blind-retry'}),/SOURCE_CHANGED|RECONCILIATION/);
  const observed=await f.client.mailAction('reconcile',{taskId:admitted.taskId,draft}) as any;assert.equal(observed.drafts[0].publish.state,'verified');assert.equal(observed.drafts[0].publish.providerDraftId,'draft-1');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/drafts')).length,1);
 }finally{await f.close();}
});
