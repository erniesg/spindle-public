import {existsSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {CallBudget,type ModelDeclaration} from '../../core/models/provider.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import {createDriveArtifactTool} from '../../core/preparation/drive-tool.js';
import {preparationBudget} from '../../core/preparation/budget.js';
import type {PreparationConfig} from '../../core/preparation/service.js';
import type {Decision,ToolDefinition} from '../../core/agent/contracts.js';

// Scoped-inventory schema descriptions and retained correction history share this fixture context.
// Keep production admission bounds unchanged; the offline fixture must have enough declared context.
const model:ModelDeclaration={provider:'nebius',id:'invented-offline-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:0.01,outputUsdPerMillion:0.01,verifiedAt:'2026-10-26T00:00:00Z',source:'https://example.test/offline-pricing'}};
const schema={jsonSchema:{type:'object'},parse:(v:unknown)=>v};
const delay=()=>new Promise(r=>setTimeout(r,5));
async function fixture(options:{saveOutputs?:boolean;attemptDraftUpload?:boolean;writeGrant?:boolean;bash?:boolean;loseUploadAck?:boolean;parentAuthorized?:boolean;unknownUpload?:boolean;holdCredential?:boolean;foreignArtifact?:boolean;sourceArtifact?:boolean}={}){
 const directory=await mkdtemp(join(process.cwd(),'.local/workflow/api-')),key=randomBytes(32),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
 let sourceVersion='7',releaseCredential:()=>void=()=>{},credentialArrived:()=>void=()=>{};const credentialAt=new Promise<void>(r=>{credentialArrived=r;}),credentialGate=new Promise<void>(r=>{releaseCredential=r;});
 const requests:unknown[]=[],googleCalls:string[]=[],created=new Map<string,{name:string;mimeType:string;bytes:Buffer}>();let generated=0,posts=0;
 const grants=[scopes.mail,scopes.drive,...(options.writeGrant===false?[]:['https://www.googleapis.com/auth/drive.file'])];
 const bytes=Buffer.from('000045 invented source\n'+'.'.repeat(600000));
 const metadata=(id:string)=>id==='root'?{id,name:'Selected folder',mimeType:'application/vnd.google-apps.folder',parents:[],version:'1',trashed:false,isAppAuthorized:options.parentAuthorized!==false,capabilities:{canAddChildren:true}}:id==='source'?{id,name:'Invented source.txt',mimeType:'text/plain',parents:['root'],version:sourceVersion,trashed:false}:created.has(id)?{id,name:created.get(id)!.name,mimeType:created.get(id)!.mimeType,parents:['root'],version:'1',size:String(created.get(id)!.bytes.length),trashed:false}:undefined;
 const http:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));googleCalls.push(url.pathname);
  if(url.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:grants.join(' ')});
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(url.pathname.endsWith('/generateIds'))return Response.json({ids:['new-output-'+(++generated)],space:'drive'});
  if(url.pathname==='/upload/drive/v3/files'){
   posts++;const body=Buffer.from(init!.body as Uint8Array),boundary=String((init!.headers as Record<string,string>)['Content-Type']).split('boundary=')[1]!,split=body.indexOf('\r\n\r\n'),end=body.indexOf('\r\n--'+boundary,split+4),m=JSON.parse(body.subarray(split+4,end).toString());const start=body.indexOf('\r\n\r\n',end+2)+4,last=body.lastIndexOf('\r\n--'+boundary);created.set(m.id,{name:m.name,mimeType:m.mimeType,bytes:body.subarray(start,last)});
   if((options.loseUploadAck||options.unknownUpload)&&posts===1){if(options.unknownUpload)created.delete(m.id);throw Error('Invented lost acknowledgement');}return Response.json(metadata(m.id));
  }
  if(url.pathname==='/drive/v3/files')return Response.json({files:[{id:'source',name:'Invented source.txt',mimeType:'text/plain',version:'7'}]});
  const id=url.pathname.split('/').at(-1)!;
  if(url.searchParams.get('alt')==='media'){if(id==='source')return new Response(bytes);const f=created.get(id);return f?new Response(new Uint8Array(f.bytes)):new Response(null,{status:404});}
  const m=metadata(id);return m?Response.json(m):new Response(null,{status:404});
 };
 const budget=new CallBudget(0.2,100);
 const config:PreparationConfig={tasks,store,workspaceId:'account-private',buildIdentity:'invented-build-offline',maxTurns:16,
  provider:c=>new NebiusAgentProvider({model,budget:preparationBudget(tasks,c.taskId,budget,'decision'),credential:async()=>{if(options.holdCredential){credentialArrived();await credentialGate;}await c.binding.assertCurrent();return 'invented-not-real-key';},persist:c.sessions.persist,transport:async(_input,init)=>{
   const body=JSON.parse(String(init!.body));requests.push(body);const state=JSON.parse(body.messages[1].content).untrustedTask,p=state.preparation,observations=state.observations;
   let decision:Decision;
   if(options.bash)decision={kind:'tool',name:'bash',args:{command:state.requestedOutcome}};
   else if(!observations.length)decision={kind:'tool',name:'drive.list',args:{folderId:p.rootId}};
   else if(!p.sources.some((s:any)=>s.providerId==='source'))decision={kind:'tool',name:'drive.read',args:{fileId:'source'}};
   else if(!observations.some((o:any)=>o.data?.kind==='fixture.extraction'))decision={kind:'tool',name:'document.extract_text',args:{inputId:p.sources.find((s:any)=>s.providerId==='source').id,pageIndex:0}};
   else if(!p.fields.length){const e=observations.find((o:any)=>o.data?.kind==='fixture.extraction'),s=p.sources.find((s:any)=>s.providerId==='source');decision={kind:'tool',name:'preparation.record_fields',args:{fields:[{id:'reference',label:'Reference',value:'000045',unresolved:false,citations:[{artifactId:e.artifacts[0].id,sourceId:s.id,sourceVersion:s.sha256}]}]}};}
   else if(!observations.some((o:any)=>o.data?.kind==='fixture.image'&&o.data.revision===p.revision))decision={kind:'tool',name:'image.crop_resize',args:{inputId:p.sources.find((s:any)=>s.providerId==='source').id}};
   else if(!p.outputs.some((o:any)=>o.revision===p.revision)){const output=observations.filter((o:any)=>o.data?.kind==='fixture.image').at(-1);decision={kind:'tool',name:'drive.create_artifact',args:{artifactId:options.foreignArtifact?'foreign-artifact':options.sourceArtifact?p.sources.find((s:any)=>s.providerId==='source').snapshotArtifactId:output.artifacts[0].id,name:'Prepared output r'+p.revision+'.png'}};}
   else if(!observations.some((o:any)=>o.data?.kind==='spindle.session-export.v1'&&o.data.fixtureRevision===p.revision)&&!p.outputs.some((u:any)=>u.revision===p.revision&&u.name.endsWith('.json')))decision={kind:'tool',name:'session.export',args:{}};
   else decision={kind:'ready',result:'Prepared invented output'};
   // Export cutoff naturally excludes this future call. Pick the latest actual export artifact.
   const last=observations.at(-1);if(p.saveOutputs===false&&!options.attemptDraftUpload&&observations.some((o:any)=>o.data?.kind==='fixture.image'&&o.data.revision===p.revision))decision=observations.some((o:any)=>o.data?.kind==='spindle.session-export.v1'&&o.data.revision===p.revision)?{kind:'ready',result:'Local invented draft prepared; nothing uploaded'}:{kind:'tool',name:'session.export',args:{}};
   if(p.saveOutputs!==false&&last?.data?.kind==='spindle.session-export.v1')decision={kind:'tool',name:'drive.create_artifact',args:{artifactId:last.data.artifactId,name:'Visible session r'+p.revision+'.json'}};
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:decision})}}],usage:{prompt_tokens:100,completion_tokens:30}});
  }}),
  tools:c=>{
   // Explicitly OFFLINE fixture transformations. Not PDF/image native or model-quality proof.
   const extract:ToolDefinition={name:'document.extract_text',version:'fixture',effect:'write_local',capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(args,ctx){const id=(args as any).inputId,a=store.put(c.namespace,Buffer.from('Reference 000045'),'text/plain',[id]).artifact;return {callId:ctx.callId,status:'ok',data:{kind:'fixture.extraction',text:'Reference 000045',password:'NEVER_EXPORT_SECRET',relativePath:'/home/private/NEVER_EXPORT_PATH',authorization:'Bearer NEVER_EXPORT_BEARER'},artifacts:[a],evidence:[],observations:['Offline invented extraction fixture only']};}};
   const image:ToolDefinition={name:'image.crop_resize',version:'fixture',effect:'write_local',capabilities:[],inputSchema:schema,outputSchema:schema,async invoke(args,ctx){const p=tasks.get(c.taskId).preparation!,a=store.put(c.namespace,Buffer.from('Invented output revision '+p.revision+' value '+p.fields[0]!.value),'image/png',[(args as any).inputId]).artifact;return {callId:ctx.callId,status:'ok',data:{kind:'fixture.image',revision:p.revision},artifacts:[a],evidence:[],observations:['Offline bytes fixture, NOT a decoded image']};}};
   return [extract,image,createDriveArtifactTool(c)];
  }};
 let server=await startTrackingServer(join(directory,'account'),key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http},config);
 const client=new AccountClient(server.origin);await client.signin('invented-owner','invented-password-123',true);
 const flow=await client.connectGoogle(),url=new URL(flow.authorizationUrl),callback=new URL(url.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:url.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);await client.selectGoogleRoots(flow.connectionId,['root']);
 const request=async(text='Prepare invented outputs',requestId='invented-request')=>client.prepareApplication({connectionId:flow.connectionId,rootId:'root',request:text,requestId,processingConsent:true,saveOutputs:options.saveOutputs??true});
 const settled=async(taskId:string)=>{for(let i=0;i<400;i++){const t=await client.preparationTask(taskId);if(t.state!=='working')return t;await delay();}throw Error('Fixture did not settle');};
 return {client,server,tasks,store,requests,googleCalls,created,request,settled,flow,posts:()=>posts,directory,credentialAt,releaseCredential,bumpSource:()=>{sourceVersion='8';},reopen:async()=>{await server.close();server=await startTrackingServer(join(directory,'account'),key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http},config);const restored=new AccountClient(server.origin);await restored.signin('invented-owner','invented-password-123');return restored;},close:async()=>{releaseCredential();await server.close();store.close();tasks.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}

test('authenticated literal request -> actual AgentRuntime and Nebius adapter -> registered upload/readback/session; correction new revision',async()=>{
 const f=await fixture();try{
  const marker=join(f.directory,'MUST_NOT_EXIST'),punctuation='!?!?! WTF IS EVEN THIS CRAP URE SENDING BACK $(touch '+marker+') ; `touch '+marker+'`';
  const receipt=await f.request(punctuation),t=await f.settled(receipt.taskId);
  assert.equal(t.state,'ready',t.blocker);assert.equal(t.request,punctuation);assert.equal(f.tasks.get(t.taskId).requestedOutcome,punctuation);assert.equal(t.fields[0]!.value,'000045');assert.equal(t.outputs.length,2);assert.equal(f.posts(),2);assert.ok(t.outputs.every(o=>o.state==='verified'&&o.url?.startsWith('https://drive.google.com/file/d/')));await assert.rejects(access(marker));
  assert.equal(await f.request(punctuation).then(t=>t.taskId),t.taskId);assert.equal(f.posts(),2);
  assert.ok(JSON.stringify(f.requests).includes('WTF IS EVEN THIS CRAP'));assert.ok(JSON.stringify(f.requests).includes('fixture.extraction'));assert.ok(JSON.stringify(f.requests).includes('drive.create_artifact'));
  const sessionFile=[...f.created.values()].find(f=>f.mimeType==='application/json')!;const session=sessionFile.bytes.toString();assert.ok(session.includes('spindle.visible-session.v1'));assert.ok(session.includes('Committed visible records'));for(const secret of ['NEVER_EXPORT_SECRET','NEVER_EXPORT_PATH','NEVER_EXPORT_BEARER','invented-access','invented-refresh','invented-not-real-key','relativePath'])assert.ok(!session.includes(secret),secret);
  const corrected=await f.client.correctPreparation({taskId:t.taskId,expectedRevision:1,fieldId:'reference',value:'000099'});assert.equal(corrected.revision,2);const second=await f.settled(t.taskId);assert.equal(second.fields[0]!.value,'000099');assert.equal(second.state,'ready',second.blocker);assert.equal(f.posts(),4);assert.ok([...f.created.values()].some(x=>x.bytes.includes('000099')));assert.ok([...f.created.values()].some(x=>x.bytes.includes('000045')));
  assert.ok(f.requests.every(request=>{const bytes=Buffer.byteLength(JSON.stringify(request));return bytes<=65_536&&bytes+1024<=model.inputContextTokens;}),'every dispatched fixture request remains within the unchanged provider admission bounds');
  await assert.rejects(f.client.correctPreparation({taskId:t.taskId,expectedRevision:1,fieldId:'reference',value:'stale'}));
  const other=new AccountClient(f.server.origin);await other.signin('invented-other','invented-password-123',true);await assert.rejects(other.preparationTask(t.taskId));await assert.rejects(other.preparationArtifact(t.taskId,t.artifacts[0]!.id));
  const artifact=await f.client.preparationArtifact(t.taskId,t.artifacts[0]!.id);assert.equal(artifact.bytes.length,t.artifacts[0]!.bytes);
 }finally{await f.close();}
});

test('local draft mode needs processing consent but no write consent; corrections retain whole-task budgets',async()=>{
 const f=await fixture({saveOutputs:false,writeGrant:false});try{const r=await f.request('!?!?! draft only $(touch NEVER_EXECUTE)'),t=await f.settled(r.taskId);assert.equal(t.state,'ready',t.blocker);assert.equal(t.outputs.length,0);assert.ok(t.artifacts.length>0);assert.equal(f.posts(),0);const before=f.tasks.get(t.taskId).preparation!.modelBudget.decisionCalls;await f.client.correctPreparation({taskId:t.taskId,expectedRevision:1,fieldId:'reference',value:'000099'});const corrected=await f.settled(t.taskId);assert.equal(corrected.revision,2);assert.equal(corrected.state,'ready',corrected.blocker);assert.equal(corrected.fields[0]!.value,'000099');assert.equal(corrected.outputs.length,0);assert.equal(f.posts(),0);assert.ok(f.tasks.get(t.taskId).preparation!.modelBudget.decisionCalls>before);const restored=await f.reopen(),after=await restored.preparationTask(t.taskId);assert.equal(after.state,'ready');assert.equal(after.revision,2);assert.equal(after.outputs.length,0);assert.equal(f.posts(),0);}finally{await f.close();}
});

test('local draft mode denies model-requested external writes even when Google already has a write grant',async()=>{
 const f=await fixture({saveOutputs:false,attemptDraftUpload:true});try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(t.outputs.length,0);assert.equal(f.posts(),0);
  // The Drive write tool is not offered in local draft mode, so the scripted attempt is an unregistered call that never dispatches.
  assert.match(t.blocker!,/Repeated UNREGISTERED_TOOL/);assert.ok(f.tasks.get(r.taskId).observations.some(o=>o.error?.code==='UNREGISTERED_TOOL'));}finally{await f.close();}
});

test('unknown model bash tool rejected, owner prose never executed',async()=>{
 const f=await fixture({bash:true});try{const r=await f.request('!?!?! $(touch NEVER_EXECUTE)'),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(f.posts(),0);
  // Unknown tools are refused by the runtime (UNREGISTERED_TOOL) and never executed; repeated refusals stop the run.
  const observations=f.tasks.get(t.taskId).observations;assert.ok(observations.length>0);assert.ok(observations.every(o=>o.status==='failed'&&o.error?.code==='UNREGISTERED_TOOL'),JSON.stringify(observations.map(o=>o.error)));
  assert.equal(t.blocker,'Repeated UNREGISTERED_TOOL');assert.equal(observations.length,2,'two refusals are feedback; the third stops the run');assert.equal(existsSync(join(process.cwd(),'NEVER_EXECUTE')),false);assert.equal(existsSync(join(f.directory,'NEVER_EXECUTE')),false);}finally{await f.close();}
});

test('missing genuine write grant retains local partial work and never posts an output',async()=>{
 const f=await fixture({writeGrant:false});try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(f.posts(),0);assert.ok(t.artifacts.length>0);assert.ok(f.tasks.get(t.taskId).observations.some(o=>o.status==='needs_input'));}finally{await f.close();}
});

test('lost upload acknowledgement persists uncertainty; explicit resume reconciles readback without rePOSTing original',async()=>{
 const f=await fixture({loseUploadAck:true});try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(t.recovery,'reconciliation_required');assert.equal(f.posts(),1);assert.equal(f.created.size,1);assert.equal(f.tasks.get(t.taskId).pending?.effect,'external_write');await f.client.resumePreparation(t.taskId);const recovered=await f.settled(t.taskId);assert.equal(recovered.state,'ready',recovered.blocker);assert.equal(f.posts(),2);assert.equal(f.created.size,2);assert.equal([...f.created.values()].filter(v=>v.mimeType==='image/png').length,1);}finally{await f.close();}
});

test('unobserved upload remains uncertain after404, never new-ID or automatic post retry',async()=>{
 const f=await fixture({unknownUpload:true});try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');const intent=f.tasks.get(t.taskId).preparation!.uploads[0]!.intent;await assert.rejects(f.client.resumePreparation(t.taskId));assert.equal(f.posts(),1);assert.deepEqual(f.tasks.get(t.taskId).preparation!.uploads[0]!.intent,intent);}finally{await f.close();}
});

test('foreign artifacts and original source snapshots cannot be uploaded',async()=>{
 for(const options of [{foreignArtifact:true},{sourceArtifact:true}]){const f=await fixture(options);try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(f.posts(),0);}finally{await f.close();}}
});

test('provider per-folder authorization is not fabricated by a local selected root',async()=>{
 const f=await fixture({parentAuthorized:false});try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'blocked');assert.equal(f.posts(),0);assert.ok(t.artifacts.length);await assert.rejects(f.client.checkGoogleOutputParent(f.flow.connectionId,'root'));await assert.rejects(f.client.googleOutputPicker(f.flow.connectionId,'root'),/GOOGLE_PICKER_CONFIGURATION_REQUIRED/);}finally{await f.close();}
});

test('output consent requests the single full consent (full Drive, compose); denial preserves readonly source grants',async()=>{
 const f=await fixture({writeGrant:false});try{const start=await f.client.authorizeGoogleOutputs(f.flow.connectionId),auth=new URL(start.authorizationUrl),requested=auth.searchParams.get('scope')!.split(' ');assert.deepEqual(requested,[scopes.mail,scopes.drive,'https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/drive']);assert.ok(!requested.includes('https://www.googleapis.com/auth/drive.file'),'drive.file is implied by full Drive, not requested separately');assert.equal(auth.searchParams.get('include_granted_scopes'),'true');const callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,error:'access_denied'}).toString();assert.equal((await fetch(callback)).status,400);const row=(await f.client.googleConnections()).connections.find(c=>c.id===f.flow.connectionId)!;assert.equal(row.status,'connected');assert.deepEqual(row.roots,['root']);assert.ok(row.grants.includes(scopes.drive));assert.ok(!row.grants.includes('https://www.googleapis.com/auth/drive.file'));}finally{await f.close();}
});

test('cancel/revoke while lazy credentials are pending prevents model dispatch and retains durable reservation',async()=>{
 const f=await fixture({holdCredential:true});try{const r=await f.request();await f.credentialAt;await f.client.cancelPreparation(r.taskId);f.releaseCredential();const t=await f.settled(r.taskId);assert.equal(t.state,'cancelled');assert.equal(f.requests.length,0);assert.equal(f.posts(),0);assert.equal(f.tasks.get(t.taskId).preparation!.modelBudget.decisionCalls,1);await assert.rejects(f.client.resumePreparation(t.taskId));}finally{await f.close();}
});

test('unselected root and request-ID rebinding fail before model dispatch',async()=>{
 const f=await fixture({holdCredential:true});try{await assert.rejects(f.client.prepareApplication({connectionId:f.flow.connectionId,rootId:'foreign-root',request:'Invented',requestId:'wrong-root',processingConsent:true,saveOutputs:true}));assert.equal(f.requests.length,0);const r=await f.request('first request');await assert.rejects(f.request('different request'));await f.client.cancelPreparation(r.taskId);f.releaseCredential();assert.equal(f.requests.length,0);}finally{await f.close();}
});

test('changed source version blocks a corrected revision and preserves earlier verified work',async()=>{
 const f=await fixture();try{const r=await f.request(),t=await f.settled(r.taskId);assert.equal(t.state,'ready');f.bumpSource();await f.client.correctPreparation({taskId:t.taskId,expectedRevision:1,fieldId:'reference',value:'000099'});const changed=await f.settled(t.taskId);assert.equal(changed.state,'blocked');assert.match(changed.blocker!,/source version changed/);assert.equal(f.posts(),2);assert.equal(changed.outputs.filter(o=>o.state==='verified').length,2);}finally{await f.close();}
});

test('normal server reopen restores same owned task, session and immutable artifact bytes without replay',async()=>{
 const f=await fixture();try{const r=await f.request(),t=await f.settled(r.taskId),calls=f.requests.length;const restored=await f.reopen(),after=await restored.preparationTask(t.taskId);assert.equal(after.taskId,t.taskId);assert.equal(after.state,'ready');assert.deepEqual(after.fields,t.fields);assert.deepEqual(after.outputs,t.outputs);assert.equal(f.requests.length,calls);assert.equal(f.posts(),2);const snapshot=await restored.preparationArtifact(t.taskId,t.artifacts[0]!.id);assert.equal(snapshot.bytes.length,t.artifacts[0]!.bytes);const replay=await restored.prepareApplication({connectionId:f.flow.connectionId,rootId:'root',request:t.request,requestId:'invented-request',processingConsent:true,saveOutputs:true});assert.equal(replay.taskId,t.taskId);assert.equal(f.requests.length,calls);}finally{await f.close();}
});
