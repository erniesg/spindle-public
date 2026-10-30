import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore, digest } from '../../core/evidence/store.js';
import { spawnSync } from 'node:child_process';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';
import { EmailDrafts, MailFailure, mailBinding, mailSendGrants, reconcileOutgoingMail, type DraftRef, type MailSendHost, type MailSendIntent, type MailSendApproval, type SendOutcome } from '../../core/connectors/google/outgoing.js';
import { createOutgoingMailTools } from '../../core/connectors/google/outgoing-tools.js';
import type { ToolContext, ToolDefinition } from '../../core/agent/contracts.js';

const namespace={workspaceId:'invented-workspace',accountId:'sender@example.test'};
const context=():ToolContext=>({callId:'call',taskId:'task',runId:'run',...namespace,scope:{sources:[],destinations:[],grants:[]},budget:{limit:10,used:0},signal:new AbortController().signal,isCurrent:()=>true});
function setup(){const root=mkdtempSync(join(process.env.RUCKSACK_SCRATCH_ROOT??'/home/ubuntu/.local/state/rucksack/scratch','email-tools-'));const store=new EvidenceStore(root);return {root,store,close(){store.close();rmSync(root,{recursive:true,force:true});}};}
const content={to:[{address:'recipient@example.test',name:'Invented recipient'}],subject:'Invented request',text:'Hello\nInvented body'};
async function invoke(tools:ToolDefinition[],name:string,args:unknown,ctx=context()){
 const tool=tools.find(t=>t.name===name)!;const result=await tool.invoke(tool.inputSchema.parse(args),ctx);tool.outputSchema.parse(result.data);return result;
}
async function local(tools:ToolDefinition[],value:unknown=content,ctx=context()){
 const result=await invoke(tools,'mail.draft.create',{content:value,provenanceIds:[]},ctx);assert.equal(result.status,'ok');return (result.data as any).draft as DraftRef;
}
/** Fixture-only caller adapter using the existing SQLite connection. Not production
 * approval authority or a second account/intent database. reserve commits synchronously. */
function hostFixture(f:ReturnType<typeof setup>){
 let protectedValue:string|undefined=JSON.stringify({refreshToken:'FIXTURE_REFRESH_NEVER_REPORT',accountId:namespace.accountId,connectionEpoch:'epoch-1',grants:[scopes.mail,mailSendGrants.send]});
 let approved:MailSendApproval|undefined,revoked=false,tokenCalls=0,sendCalls=0;
 const events:string[]=[];const bodies:Buffer[]=[];let transport:typeof fetch=async()=>Response.json({id:'gmail-message',threadId:'gmail-thread'});
 const oauth=new GoogleOAuth('fixture-client',{
  async get(){events.push('credential');return protectedValue;},async set(_id,v){protectedValue=v;},async delete(){protectedValue=undefined;},async compareAndSet(_id,old,v){if(protectedValue!==old)return false;protectedValue=v;return true;}
 },async()=>{tokenCalls++;events.push('token');return Response.json({access_token:'FIXTURE_ACCESS_NEVER_REPORT'});});
 f.store.db.exec('CREATE TABLE fixture_mail_intents(id TEXT PRIMARY KEY, body TEXT NOT NULL, outcomes TEXT NOT NULL)');
 const host:MailSendHost={oauth,connectionId:'fixture-connection',connectionEpoch:'epoch-1',grant:mailSendGrants.send,
  async approval(){events.push('approval');return approved&&structuredClone(approved);},
  async assertCurrent(_ctx,a){events.push('owner-fence');if(revoked||!approved||JSON.stringify(a)!==JSON.stringify(approved))throw new MailFailure('MAIL_APPROVAL_REVOKED');},
  journal:{
   async reserve(intent){events.push('reserve');const saved=f.store.db.prepare('SELECT body FROM fixture_mail_intents WHERE id=?').get(intent.id);if(saved){assert.equal(saved.body,JSON.stringify(intent));return 'existing';}f.store.db.prepare('INSERT INTO fixture_mail_intents VALUES (?,?,?)').run(intent.id,JSON.stringify(intent),'[]');return 'new';},
   async assertReserved(intent){events.push('intent-fence');assert.equal(f.store.db.prepare('SELECT body FROM fixture_mail_intents WHERE id=?').get(intent.id)?.body,JSON.stringify(intent));},
   async settle(intent,outcome){events.push('settle');const row=f.store.db.prepare('SELECT outcomes FROM fixture_mail_intents WHERE id=?').get(intent.id)!;f.store.db.prepare('UPDATE fixture_mail_intents SET outcomes=? WHERE id=?').run(JSON.stringify([...JSON.parse(row.outcomes as string),outcome]),intent.id);}
  },
  http:async(input,init)=>{sendCalls++;events.push('send');assert.equal(String(input),'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.equal((init?.headers as any).Authorization,'Bearer FIXTURE_ACCESS_NEVER_REPORT');
   const row=f.store.db.prepare('SELECT body FROM fixture_mail_intents WHERE id=?').get(approved!.id);assert.ok(row,'durable intent precedes dispatch');
   const intent=JSON.parse(row.body as string) as MailSendIntent;const bytes=Buffer.from(JSON.parse(init!.body as string).raw,'base64url');assert.equal(digest(bytes),intent.binding.mime.sha256);bodies.push(bytes);return transport(input,init);
  }
 };
 return {host,events,bodies,get tokenCalls(){return tokenCalls;},get sendCalls(){return sendCalls;},approve(ref:DraftRef,id='approval-1'){approved={id,binding:mailBinding(namespace,'epoch-1',new EmailDrafts(f.store,namespace).read(ref))};return structuredClone(approved);},setApproval(a:MailSendApproval|undefined){approved=a;},revoke(){revoked=true;},setTransport(t:typeof fetch){transport=t;},updateConnection(patch:Record<string,unknown>){protectedValue=JSON.stringify({...JSON.parse(protectedValue!),...patch});},intent(){return JSON.parse(f.store.db.prepare('SELECT body FROM fixture_mail_intents').get()!.body as string) as MailSendIntent;},outcomes(){return JSON.parse(f.store.db.prepare('SELECT outcomes FROM fixture_mail_intents').get()!.outcomes as string) as SendOutcome[];}};
}
test('registered local drafting works without OAuth and send denies without trusted approval',async()=>{
 const f=setup();try{
  const tools=createOutgoingMailTools({store:f.store,namespace});
  const draft=tools.find(t=>t.name==='mail.draft.create')!,send=tools.find(t=>t.name==='mail.send')!;
  const result=await draft.invoke(draft.inputSchema.parse({content:{to:[{address:'recipient@example.test'}],subject:'Invented',text:'Hello'},provenanceIds:[]}),context());
  assert.equal(result.status,'ok');assert.equal((result.data as any).state,'local_draft');
  const denied=await send.invoke({draft:(result.data as any).draft},context());
  assert.equal((denied.data as any).state,'denied');assert.equal((denied.data as any).code,'MAIL_APPROVAL_REQUIRED');
 }finally{f.close();}
});

test('actual runtime registry exposes immutable create/read/edit results to next turns without OAuth',async()=>{
 const f=setup(),tasks=new AgentStore(':memory:');try{
  const tools=createOutgoingMailTools({store:f.store,namespace});const task=tasks.admit({...namespace,messageId:'draft-task',outcome:'Prepare invented email'},20);let original:DraftRef|undefined,edited:DraftRef|undefined;
  await new AgentRuntime(tasks,tools).run(task.id,{id:'scripted-fixture-not-live-model',async next(task,metadata){
   for(const name of ['mail.draft.create','mail.draft.read','mail.draft.edit','mail.send'])assert.ok(metadata.some(t=>t.name===name));
   if(!task.observations.length)return {kind:'tool',name:'mail.draft.create',args:{content,provenanceIds:[]}};
   const first=task.observations[0].data as any;original=first.draft;assert.equal(first.state,'local_draft');assert.equal(first.record.content.text,content.text);
   if(task.observations.length===1)return {kind:'tool',name:'mail.draft.edit',args:{draft:original,content:{...content,text:'Corrected invented body'},provenanceIds:[]}};
   const second=task.observations[1].data as any;edited=second.draft;assert.equal(edited!.revision,2);assert.notEqual(edited!.sha256,original!.sha256);assert.equal(edited!.draftId,original!.draftId);assert.deepEqual(second.record.parent,original);
   if(task.observations.length===2)return {kind:'tool',name:'mail.draft.read',args:{draft:original}};
   assert.equal((task.observations[2].data as any).record.content.text,content.text);return {kind:'ready',result:'Observed original and edited immutable revisions'};
  }},4);
  assert.equal(tasks.get(task.id).status,'ready');assert.equal(tasks.get(task.id).observations.length,3);
  const reopened=new EvidenceStore(f.root);try{const drafts=new EmailDrafts(reopened,namespace);assert.equal(drafts.read(edited).record.content.text,'Corrected invented body');assert.throws(()=>new EmailDrafts(reopened,{...namespace,workspaceId:'wrong'}).read(original));assert.throws(()=>new EmailDrafts(reopened,{...namespace,accountId:'other@example.test'}).read(original));}finally{reopened.close();}
 }finally{tasks.close();f.close();}
});

test('standards MIME decodes Unicode headers, text/HTML, reply metadata and exact scoped attachment bytes',async()=>{
 const f=setup();try{
  const bytes=Buffer.from('%PDF-1.7\nInvented attachment\n\x00\xff','latin1'),a=f.store.put(namespace,bytes,'application/pdf',[],{provider:'user',providerId:'invented-source',providerVersion:'1'});
  const ctx=context();ctx.scope.sources.push(a.source!);
  const tools=createOutgoingMailTools({store:f.store,namespace});
  const value={...content,to:[{address:'"quoted local"@exämple.test',name:'Récepteur 日本語'}],cc:[{address:'cc@example.test'}],bcc:[{address:'bcc@example.test'}],subject:'Invented 日本語 subject '.repeat(10),text:'Hello café\nSecond line',html:'<p>Invented café</p>',reply:{threadId:'known-thread',inReplyTo:'<original@example.test>',references:['<earlier@example.test>','<original@example.test>']},attachments:[{artifactId:a.artifact.id,sha256:a.artifact.sha256,name:'Invented résumé 日本語.pdf'}]};
  const result=await invoke(tools,'mail.draft.create',{content:value,provenanceIds:[a.source!.id]},ctx),data=result.data as any;
  assert.deepEqual(data.record.provenanceIds,[a.source!.id]);assert.ok(result.artifacts[0].derivedFrom.includes(a.source!.id));
  const mime=f.store.read(namespace,data.record.mime.artifactId);assert.equal(digest(mime),data.record.mime.sha256);assert.equal(data.record.attachments[0].mimeType,'application/pdf');
  const parsed=spawnSync('python3',['-c',`import sys,email.policy,email.parser,json,hashlib\nm=email.parser.BytesParser(policy=email.policy.default).parsebytes(sys.stdin.buffer.read())\nprint(json.dumps({'subject':str(m['Subject']),'to':str(m['To']),'bcc':str(m['Bcc']),'reply':str(m['In-Reply-To']),'id':str(m['Message-ID']),'defects':[str(d) for p in m.walk() for d in p.defects],'parts':[{'mime':p.get_content_type(),'filename':p.get_filename(),'hex':p.get_payload(decode=True).hex(),'sha256':hashlib.sha256(p.get_payload(decode=True)).hexdigest()} for p in m.walk() if not p.is_multipart()]}))`],{input:mime,encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);const decoded=JSON.parse(parsed.stdout);assert.deepEqual(decoded.defects,[]);assert.equal(decoded.subject,value.subject);assert.match(decoded.to,/Récepteur 日本語/);assert.equal(decoded.bcc,'bcc@example.test');assert.equal(decoded.reply,value.reply.inReplyTo);assert.equal(decoded.id,data.record.mime.messageId);
  assert.equal(Buffer.from(decoded.parts[0].hex,'hex').toString(),'Hello café\r\nSecond line');assert.equal(Buffer.from(decoded.parts[1].hex,'hex').toString(),value.html);assert.equal(decoded.parts[2].filename,value.attachments[0].name);assert.equal(decoded.parts[2].sha256,a.artifact.sha256);assert.equal(decoded.parts[2].hex,bytes.toString('hex'));
  const snapshot=new EmailDrafts(f.store,namespace).read(data.draft);assert.deepEqual(new EmailDrafts(f.store,namespace).mime(snapshot,()=>true),mime);
 }finally{f.close();}
});

for(const [label,change] of [
 ['header injection',{subject:'Invented\r\nBcc: hidden@example.test'}],
 ['address injection',{to:[{address:'a@example.test\nBcc:hidden@example.test'}]}],
 ['invalid address',{to:[{address:'not-an-email'}]}],
 ['name injection',{to:[{address:'a@example.test',name:'a\r\nb'}]}],
 ['missing body',{text:undefined}],
 ['oversized body',{text:'x'.repeat(1024*1024+1)}],
 ['arbitrary path attachment',{attachments:[{path:'/etc/passwd',name:'x'}]}],
 ['arbitrary URL attachment',{attachments:[{url:'https://example.test/secret',name:'x'}]}]
] as const)test(`draft validation denies ${label} without artifacts`,async()=>{
 const f=setup();try{const tool=createOutgoingMailTools({store:f.store,namespace})[0];const result=await tool.invoke({content:{...content,...change},provenanceIds:[]},context());assert.equal((result.data as any).state,'denied');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()!.n,0);}finally{f.close();}
});

test('attachment admission, wrong hash/MIME and namespace fail closed; generic binary remains useful',async()=>{
 const f=setup();try{
  const bad=f.store.put(namespace,Buffer.from('not a PDF'),'application/pdf').artifact;
  const other=f.store.put({...namespace,workspaceId:'different'},Buffer.from('other'),'text/plain').artifact;
  const tools=createOutgoingMailTools({store:f.store,namespace,allowAttachment:(_ctx,id)=>id===bad.id||id===other.id});
  for(const [a,expected] of [[{artifactId:bad.id,sha256:bad.sha256,name:'x.pdf'},'MAIL_ATTACHMENT_MIME_MISMATCH'],[{artifactId:bad.id,sha256:'0'.repeat(64),name:'x.pdf'},'MAIL_ATTACHMENT_CHANGED'],[{artifactId:bad.id,sha256:bad.sha256,name:'../x.pdf'},'MAIL_INVALID_ATTACHMENT']] as const){const r=await tools[0].invoke({content:{...content,attachments:[a]},provenanceIds:[]},context());assert.equal((r.data as any).code,expected);}
  const wrongNamespace=await invoke(tools,'mail.draft.create',{content:{...content,attachments:[{artifactId:other.id,sha256:other.sha256,name:'other.txt'}]},provenanceIds:[]});assert.equal((wrongNamespace.data as any).code,'MAIL_ATTACHMENT_UNAVAILABLE');
  const unknown=f.store.put(namespace,Buffer.from([0,255,1]),'application/x-invented').artifact;
  let r=await invoke(tools,'mail.draft.create',{content:{...content,attachments:[{artifactId:unknown.id,sha256:unknown.sha256,name:'invented.bin'}]},provenanceIds:[]});assert.equal((r.data as any).code,'MAIL_ATTACHMENT_NOT_ADMITTED');
  const binaryTools=createOutgoingMailTools({store:f.store,namespace,allowAttachment:()=>true});const ref=await local(binaryTools,{...content,attachments:[{artifactId:unknown.id,sha256:unknown.sha256,name:'invented.bin'}]});const record=new EmailDrafts(f.store,namespace).read(ref).record;assert.equal(record.attachments[0].mimeType,'application/octet-stream');
  const noRefs=await invoke(tools,'mail.draft.read',{draft:ref},{...context(),accountId:'other@example.test'});assert.equal((noRefs.data as any).code,'MAIL_NAMESPACE_DENIED');
 }finally{f.close();}
});

for(const condition of ['no approval','changed draft','wrong approval account','wrong approval workspace','wrong approval epoch','missing journal','no send scope','stale','cancelled','wrong context namespace','reconnected'] as const)test(`send denies ${condition} before Gmail/token access where feasible`,async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host});let ref=await local(tools);const ctx=context();
  const approval=fx.approve(ref);
  if(condition==='no approval')fx.setApproval(undefined);
  if(condition==='changed draft')ref=((await invoke(tools,'mail.draft.edit',{draft:ref,content:{...content,text:'Edited'},provenanceIds:[]})).data as any).draft;
  if(condition==='wrong approval account'){approval.binding.accountId='other@example.test';fx.setApproval(approval);}
  if(condition==='wrong approval workspace'){approval.binding.workspaceId='other';fx.setApproval(approval);}
  if(condition==='wrong approval epoch'){approval.binding.connectionEpoch='epoch-2';fx.setApproval(approval);}
  if(condition==='missing journal')(fx.host as any).journal=undefined;
  if(condition==='no send scope')fx.updateConnection({grants:[scopes.mail]});
  if(condition==='stale')ctx.isCurrent=()=>false;
  if(condition==='cancelled')ctx.signal=AbortSignal.abort();
  if(condition==='wrong context namespace')ctx.workspaceId='wrong';
  if(condition==='reconnected')fx.updateConnection({connectionEpoch:'epoch-2'});
  const r=await invoke(tools,'mail.send',{draft:ref},ctx);assert.equal((r.data as any).state,'denied');assert.equal(fx.sendCalls,0);assert.equal(fx.tokenCalls,0);
  if(condition==='no send scope')assert.equal((r.data as any).code,'MAIL_SEND_GRANT_REQUIRED');
  if(['no approval','changed draft','wrong approval account','wrong approval workspace','wrong approval epoch','missing journal','stale','cancelled','wrong context namespace'].includes(condition))assert.ok(!fx.events.includes('credential'));
 }finally{f.close();}
});

test('send submits exact stable MIME once after durable intent; duplicate/reopened intent never rePOSTs',async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools);fx.approve(ref);
  const sent=await invoke(tools,'mail.send',{draft:ref});assert.equal(sent.status,'ok');assert.deepEqual(sent.data,{state:'sent',intentId:'approval-1',messageId:'gmail-message',threadId:'gmail-thread',mimeSha256:new EmailDrafts(f.store,namespace).read(ref).record.mime.sha256,mimeBytes:fx.bodies[0].length,verification:'provider_acknowledged'});
  assert.ok(fx.events.indexOf('reserve')<fx.events.indexOf('send'));assert.equal(fx.outcomes()[0].state,'sent');
  const reopened=new EvidenceStore(f.root);try{assert.equal(JSON.parse(reopened.db.prepare('SELECT body FROM fixture_mail_intents').get()!.body as string).binding.mime.sha256,digest(fx.bodies[0]));}finally{reopened.close();}
  const duplicate=await invoke(tools,'mail.send',{draft:ref});assert.equal((duplicate.data as any).state,'uncertain');assert.equal((duplicate.data as any).code,'MAIL_EXISTING_INTENT_RECONCILIATION_REQUIRED');assert.equal(fx.sendCalls,1);
  assert.throws(()=>tools.find(t=>t.name==='mail.send')!.inputSchema.parse({draft:ref,approval:fx.approve(ref)}));
 }finally{f.close();}
});

for(const scenario of ['rejected','lost response','server error','invalid success','cancel in flight','revoke in flight','settlement failure'] as const)test(`send ${scenario} preserves truthful durable outcome and never retries`,async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools),controller=new AbortController(),ctx={...context(),signal:controller.signal};fx.approve(ref);
  fx.setTransport(async()=>{
   if(scenario==='rejected')return new Response('DO NOT ECHO provider token=FIXTURE_ACCESS_NEVER_REPORT',{status:403});
   if(scenario==='lost response')throw Error('provider raw body/code/auth URL FIXTURE_ACCESS_NEVER_REPORT');
   if(scenario==='server error')return new Response('private provider body',{status:500});
   if(scenario==='invalid success')return Response.json({access_token:'FIXTURE_ACCESS_NEVER_REPORT'});
   if(scenario==='cancel in flight'){controller.abort();return Response.json({id:'late',threadId:'late-thread'});}
   if(scenario==='revoke in flight')fx.revoke();
   return Response.json({id:'gmail-message',threadId:'gmail-thread'});
  });
  if(scenario==='settlement failure')fx.host.journal.settle=async()=>{throw Error('private storage error');};
  const result=await invoke(tools,'mail.send',{draft:ref},ctx);assert.equal((result.data as any).state,scenario==='rejected'?'no_send':'uncertain');assert.equal(fx.sendCalls,1);assert.doesNotMatch(JSON.stringify(result),/FIXTURE_ACCESS|private|provider raw|https:\/\/accounts/);
  if(scenario==='settlement failure'){assert.equal((result.data as any).observedMessageId,'gmail-message');assert.equal((result.data as any).observedThreadId,'gmail-thread');}
  if(scenario!=='settlement failure')assert.equal(fx.outcomes().at(-1)!.state,scenario==='rejected'?'no_send':'uncertain');
  const again=await invoke(tools,'mail.send',{draft:ref});assert.notEqual((again.data as any).state,'sent');assert.equal(fx.sendCalls,1);
 }finally{f.close();}
});

test('cancel/revoke while approval/token/intent awaits prevents dispatch; late noncooperative waits do not send',async()=>{
 for(const stage of ['approval','token','intent'] as const){const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools),controller=new AbortController();fx.approve(ref);
  if(stage==='approval')fx.host.approval=async()=>{controller.abort();return new Promise(()=>{});};
  if(stage==='token'){const oauth=fx.host.oauth;fx.host.oauth={async connectorAccess(...args){const access=await oauth.connectorAccess(...args);return {...access,token:async()=>{controller.abort();return 'late-token';}};}};}
  if(stage==='intent'){const reserve=fx.host.journal.reserve;fx.host.journal.reserve=async(i,c)=>{const r=await reserve(i,c);fx.revoke();return r;};}
  const result=await invoke(tools,'mail.send',{draft:ref},{...context(),signal:controller.signal});assert.equal((result.data as any).state,'denied');assert.equal(fx.sendCalls,0);
 }finally{f.close();}}
});

test('an interrupted durable reservation is retained and cannot replay a send',async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools);fx.approve(ref);
  const reserve=fx.host.journal.reserve;fx.host.journal.reserve=async(i,c)=>{await reserve(i,c);throw Error('lost commit acknowledgement');};
  const first=await invoke(tools,'mail.send',{draft:ref});assert.equal((first.data as any).state,'denied');assert.equal(fx.sendCalls,0);assert.equal(fx.intent().binding.draft.sha256,ref.sha256);
  fx.host.journal.reserve=reserve;const repeated=await invoke(tools,'mail.send',{draft:ref});assert.equal((repeated.data as any).state,'uncertain');assert.equal(fx.sendCalls,0);
 }finally{f.close();}
});

test('concurrent duplicate intent serializes to exactly one fixture POST, not a Gmail guarantee',async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools);fx.approve(ref);
  // Reuse a deterministic protected accessor here: concurrent real refresh CAS
  // intentionally denies one caller before reaching journal, independently safe.
  const access={accountId:namespace.accountId,connectionEpoch:'epoch-1',async assertCurrent(){},async token(){return 'FIXTURE_ACCESS_NEVER_REPORT';}};
  fx.host.oauth={async connectorAccess(){return access;}};
  const results=await Promise.all([invoke(tools,'mail.send',{draft:ref}),invoke(tools,'mail.send',{draft:ref})]);
  assert.deepEqual(results.map(r=>(r.data as any).state).sort(),['sent','uncertain']);assert.equal(fx.sendCalls,1);
 }finally{f.close();}
});

test('host reconcile searches saved Message-ID in original account and returns candidates, never replay authority',async()=>{
 const f=setup();try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools);fx.approve(ref);fx.setTransport(async()=>{throw Error('lost');});await invoke(tools,'mail.send',{draft:ref});
  const intent=fx.intent(),requests:string[]=[];
  const options={oauth:fx.host.oauth,connectionId:fx.host.connectionId,async assertCurrent(){},http:async(input:RequestInfo|URL)=>{
   const url=new URL(String(input));requests.push(url.href);assert.equal(url.origin,'https://gmail.googleapis.com');
   if(url.searchParams.has('q')){assert.equal(url.searchParams.get('q'),`in:sent rfc822msgid:${intent.binding.mime.messageId.slice(1,-1)}`);return Response.json({messages:[{id:'candidate'}]});}
   assert.equal(url.searchParams.get('format'),'metadata');return Response.json({id:'candidate',threadId:'candidate-thread',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:intent.binding.mime.messageId}]}});
  }};
  const result=await reconcileOutgoingMail(new EmailDrafts(f.store,namespace),intent,context(),options);assert.equal(result.state,'candidates');assert.equal(result.automaticRetryAllowed,false);assert.equal(result.mimeSha256,intent.binding.mime.sha256);assert.deepEqual(result.candidates,[{messageId:'candidate',threadId:'candidate-thread'}]);assert.equal(requests.length,2);assert.equal(fx.sendCalls,1);
  const empty=await reconcileOutgoingMail(new EmailDrafts(f.store,namespace),intent,context(),{...options,http:async()=>Response.json({messages:[]})});assert.equal(empty.state,'not_observed');assert.equal(empty.automaticRetryAllowed,false);
  const wrong=structuredClone(intent);wrong.binding.accountId='other@example.test';await assert.rejects(reconcileOutgoingMail(new EmailDrafts(f.store,namespace),wrong,context(),options),/MAIL_RECONCILIATION_UNAVAILABLE/);assert.equal(requests.length,2);
  fx.updateConnection({connectionEpoch:'epoch-2'});await assert.rejects(reconcileOutgoingMail(new EmailDrafts(f.store,namespace),intent,context(),options),/MAIL_RECONCILIATION_UNAVAILABLE/);assert.equal(requests.length,2);
 }finally{f.close();}
});

test('existing AgentRuntime external_write gate remains closed before mail.send callback',async()=>{
 const f=setup(),tasks=new AgentStore(':memory:');try{
  const fx=hostFixture(f),tools=createOutgoingMailTools({store:f.store,namespace,send:fx.host}),ref=await local(tools);fx.approve(ref);const task=tasks.admit({...namespace,messageId:'gate-test',outcome:'Do not send'},10);
  await new AgentRuntime(tasks,tools).run(task.id,{id:'scripted-fixture',async next(){return {kind:'tool',name:'mail.send',args:{draft:ref}};}},1);
  assert.match(tasks.get(task.id).blocker!,/External effects are not authorised/);assert.equal(fx.sendCalls,0);assert.deepEqual(fx.events,[]);
 }finally{tasks.close();f.close();}
});

test('a model-written lookalike draft cannot display attachment metadata different from the exact MIME',async()=>{
 const f=setup();try{
  const a=f.store.put(namespace,Buffer.from('Invented attachment'),'text/plain').artifact,tools=createOutgoingMailTools({store:f.store,namespace,allowAttachment:()=>true});
  const ref=await local(tools,{...content,attachments:[{artifactId:a.id,sha256:a.sha256,name:'reviewed.txt'}]}),snapshot=new EmailDrafts(f.store,namespace).read(ref);
  snapshot.record.attachments[0].name='different-from-MIME.txt';
  const forged=f.store.put(namespace,Buffer.from(JSON.stringify(snapshot.record)),'application/vnd.spindle.mail-draft+json',snapshot.artifact.derivedFrom).artifact;
  const result=await invoke(tools,'mail.draft.read',{draft:{...ref,artifactId:forged.id,sha256:forged.sha256}});
  assert.equal((result.data as any).state,'denied');assert.equal((result.data as any).code,'MAIL_DRAFT_CHANGED');
 }finally{f.close();}
});

test('draft output schemas reject forged/malformed results and local commit faults retain runtime pending recovery',async()=>{
 const f=setup(),tasks=new AgentStore(':memory:');try{
  const tools=createOutgoingMailTools({store:f.store,namespace});
  for(const tool of tools){assert.throws(()=>tool.outputSchema.parse(null));assert.throws(()=>tool.outputSchema.parse({state:'sent',messageId:'invented'}));assert.throws(()=>tool.outputSchema.parse({state:'denied',code:'MAIL_X',secret:'private'}));}
  f.store.db.exec("CREATE TRIGGER fail_draft BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'private commit details'); END");
  const task=tasks.admit({...namespace,messageId:'commit-test',outcome:'Prepare'},10);
  await new AgentRuntime(tasks,tools).run(task.id,{id:'scripted-fixture',async next(){return {kind:'tool',name:'mail.draft.create',args:{content,provenanceIds:[]}};}},1);
  const failed=tasks.get(task.id);assert.equal(failed.recovery,'reconciliation_required');assert.equal(failed.pending?.effect,'write_local');assert.equal(failed.observations.length,0);assert.doesNotMatch(JSON.stringify(failed),/private commit details/);
 }finally{tasks.close();f.close();}
});
