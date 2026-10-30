import {test} from 'node:test';import assert from 'node:assert/strict';
import {mailFixture} from './mail-fixture.js';import {AccountClient} from '../../core/account/client.js';
import {join} from 'node:path';import {AgentStore} from '../../core/storage/agent-store.js';
import {mailSendGrants} from '../../core/connectors/google/outgoing.js';import {scopes} from '../../core/connectors/google/oauth.js';

test('ordinary production account exposes actual Gmail tools, separate incremental consent, exact draft/send and replay denial',async()=>{
 const f=await mailFixture();try{
  assert.deepEqual(f.counts(),{credentials:0,modelCalls:0});assert.deepEqual((await f.client.googleConnections()).connections[0].mailReadiness,{canDraft:false,canSend:false,requiresExactOwnerReview:true});
  await f.client.mailAction('config');await f.client.mailAction('list');assert.equal(f.calls.length,0);assert.equal(f.counts().modelCalls,0);
  const request={connectionId:f.flow.connectionId,request:'Draft my fictional workshop application email',requestId:'one-owner-request',processingConsent:true};
  const admitted=await f.client.mailAction('request',request) as any;const ready=await f.until(admitted.taskId);assert.equal(ready.state,'ready');assert.equal(ready.googleAccountId,'sender@example.test');assert.equal(ready.drafts.length,1);const draft=ready.drafts[0].draft;
  assert.deepEqual(f.counts(),{credentials:2,modelCalls:2});assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.includes('/gmail/')).length,0);
  assert.equal((await f.client.mailAction('request',request) as any).taskId,admitted.taskId);assert.equal(f.counts().modelCalls,2);
  const noGrant=await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'without-compose'}) as any;assert.equal(noGrant.drafts[0].publish.state,'denied');assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts')&&c.method==='POST').length,0);
  const upgrade=await f.client.authorizeGoogleMail(f.flow.connectionId),auth=new URL(upgrade.authorizationUrl);assert.deepEqual(new Set(auth.searchParams.get('scope')!.split(' ')),new Set([scopes.mail,scopes.drive,mailSendGrants.compose,'https://www.googleapis.com/auth/drive']));assert.equal(auth.searchParams.get('include_granted_scopes'),'true');assert.equal(auth.searchParams.get('scope')!.includes('drive.file'),false);
  f.setCompose(true);await f.callback(upgrade.authorizationUrl);assert.equal((await f.client.googleConnections()).connections[0].mailReadiness!.canSend,true);
  const saved=await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'save-current'}) as any;assert.equal(saved.drafts[0].publish.state,'verified',JSON.stringify(saved));assert.equal(f.drafts.size,1);assert.equal(f.counts().modelCalls,2,'owner save does not run AI');
  await f.client.mailAction('publish',{taskId:admitted.taskId,draft,requestId:'save-current'});assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts')&&c.method==='POST').length,1);
  const sent=await f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'send-current'}) as any;assert.equal(sent.drafts[0].send.state,'sent',JSON.stringify(sent));assert.equal(sent.drafts[0].send.messageId,'sent-message');assert.equal(f.drafts.size,0,'exact published Gmail draft is sent, not left for duplicate manual send');
  await f.client.mailAction('send',{taskId:admitted.taskId,draft,requestId:'send-current'});assert.equal(f.calls.filter(c=>c.path.endsWith('/drafts/send')).length,1);assert.equal(f.calls.some(c=>c.path.endsWith('/messages/send')),false);assert.equal(f.counts().modelCalls,2);
  const other=new AccountClient(f.app.origin);await other.signin('invented-other-owner','invented-password-123',true);await assert.rejects(other.mailAction('status',{taskId:admitted.taskId}));await assert.rejects(other.authorizeGoogleMail(f.flow.connectionId));
  assert.equal(f.calls.some(c=>c.path.includes('/drive/')),false,'mail does not need a Drive folder');
 }finally{await f.close();}
});

for(const phase of ['credential-disconnect','credential-logout','response-disconnect'] as const)test('authenticated mail provider fence: '+phase,async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const f=await mailFixture(phase==='response-disconnect'?{modelGate:gate,onModel:started,gateOnModelCall:2}:{credentialGate:gate,onCredential:started,readyOnly:true});
 const peer=new AccountClient(f.app.origin);await peer.signin('invented-mail-owner','invented-password-123');
 try{
  const request=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft invented email',requestId:'revoked-owner-request',processingConsent:true}) as any;await began;
  if(phase==='credential-logout')await f.client.signout();else await f.client.disconnectGoogle(f.flow.connectionId);
  release();let final:any;for(let i=0;i<200;i++){final=await peer.mailAction('status',{taskId:request.taskId});if(final.execution==='idle')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(final.state,'blocked',JSON.stringify(final));assert.equal(final.drafts.length,phase==='response-disconnect'?1:0);assert.equal(f.counts().modelCalls,phase==='response-disconnect'?2:0,'no model dispatch after credential-wait revocation');
 }finally{release();await f.close();}
});

test('shutdown drains the actual delayed provider transport and preserves cancellation without a late draft',async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});const f=await mailFixture({modelGate:gate,onModel:started});
 try{
  const result=await f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft an invented email',requestId:'delayed-owner-request',processingConsent:true}) as any;await began;
  let settled=false;const closing=f.app.close().then(()=>{settled=true;});await new Promise(r=>setTimeout(r,75));assert.equal(settled,false,'closing a bounded observation is not provider transport drain');release();await closing;
  const tasks=new AgentStore(join(f.directory,'account','preparation','tasks.sqlite'));try{const task=tasks.get(result.taskId);assert.equal(task.status,'cancelled');assert.equal(Object.keys(task.mail!.drafts).length,0);assert.equal(task.mail!.service!.active,undefined);}finally{tasks.close();}
 }finally{release();await f.close();}
});

test('mail account RPC requires authentication, Origin, CSRF and explicit processing consent',async()=>{
 const f=await mailFixture();try{
  const origin=f.app.origin;assert.equal((await fetch(origin+'/mail/status',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(origin+'/mail/status',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/mail',{headers:{Origin:'https://evil.example'}})).status,403);
  await assert.rejects(f.client.mailAction('request',{connectionId:f.flow.connectionId,request:'Draft',requestId:'no-consent',processingConsent:false}));assert.equal(f.counts().modelCalls,0);
  const signed=await fetch(origin+'/signin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-mail-owner',password:'invented-password-123'})});const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(origin+'/mail/config',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/mail.js')).headers.get('content-security-policy')!.includes("connect-src 'self'"),true);
 }finally{await f.close();}
});


test('prepared attachment download checks current session namespace and same-origin navigation',async()=>{
 const f=await mailFixture();try{
  const source=f.prepared(),url=f.app.origin+'/preparation/download?taskId='+source.taskId+'&artifactId='+source.artifactId;
  const signed=await fetch(f.app.origin+'/signin',{method:'POST',headers:{Origin:f.app.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-mail-owner',password:'invented-password-123'})});const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie,'Sec-Fetch-Site':'same-origin'};
  const response=await fetch(url,{headers});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),source.bytes);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-disposition'),'attachment; filename=spindle-artifact.pdf');
  assert.equal((await fetch(url,{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(url,{headers:{Cookie:cookie}})).status,403);
  assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'same-origin'}})).status,401);
  const other=new AccountClient(f.app.origin);await other.signin('invented-download-other','invented-password-123',true);
  const changed=await fetch(f.app.origin+'/signin',{method:'POST',headers:{Origin:f.app.origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-download-other',password:'invented-password-123'})});const otherCookie=changed.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual((await fetch(url,{headers:{Cookie:otherCookie,'Sec-Fetch-Site':'same-origin'}})).status,200);
  assert.notEqual((await fetch(url,{headers})).status,200,'previous session was revoked');
  assert.equal(f.counts().modelCalls,0);
 }finally{await f.close();}
});
