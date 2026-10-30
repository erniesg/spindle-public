import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startPreparationAccount} from '../../core/preparation/startup.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {ModelDeclaration} from '../../core/models/provider.js';
import type {Decision} from '../../core/agent/contracts.js';

const pricing={inputUsdPerMillion:.06,outputUsdPerMillion:.24,verifiedAt:'2026-10-26T00:00:00Z',source:'https://example.test/invented-pricing'};
const decision:ModelDeclaration={provider:'nebius',id:'invented-decision-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing};
const vision:ModelDeclaration={...decision,id:'invented-vision-model',inputContextTokens:32000,maxOutputTokens:512,images:{inputTokensUpperBound:16000,accounting:'input-tokens'},pricing:{...pricing,inputUsdPerMillion:.658,outputUsdPerMillion:1.11}};

test('actual production startup registers all real factories; normal readonly local draft API uses budgeted Nebius adapter without startup/status processing',async()=>{
 const dir=mkdtempSync(join(process.cwd(),'.local/workflow/production-')),key=randomBytes(32),budgetPath=join(dir,'invented-budget.json'),selectedRoot='invented-host-bound-opaque-root';
 // Invented ephemeral journal and transports. No owner journal, Google or paid endpoint is accessed.
 writeFileSync(budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 let credentials=0,posts=0;const modelRequests:any[]=[],source=Buffer.from('Invented selected source\n'+'.'.repeat(600000));
 const http:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));if(url.pathname==='/token')return Response.json({access_token:'invented-google-access',refresh_token:'invented-google-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(init?.method==='POST'){posts++;throw Error('No Drive create is authorized in this local draft fixture');}
  if(url.pathname==='/drive/v3/files')return Response.json({files:[{id:'source',name:'Invented selected source.txt',mimeType:'text/plain',version:'7'}]});
  if(url.searchParams.get('alt')==='media')return new Response(source);
  const id=url.pathname.split('/').at(-1);return Response.json(id===selectedRoot?{id,name:'Selected folder',mimeType:'application/vnd.google-apps.folder',version:'1',trashed:false}:{id,name:'Invented selected source.txt',mimeType:'text/plain',parents:[selectedRoot],version:'7',trashed:false});
 };
 const app=await startPreparationAccount({directory:join(dir,'account'),key,google:{clientId:'invented-client',clientSecret:'invented-secret',http},budgetPath,decisionModel:decision,visionModel:vision,credential:async()=>{credentials++;return 'invented-nebius-key';},buildIdentity:'invented-source-build-offline',sourceIdentity:{revision:'a'.repeat(40),tree:'b'.repeat(40)},modelTransport:async(input,init)=>{
  assert.equal(String(input),'https://api.tokenfactory.nebius.com/v1/chat/completions');const body=JSON.parse(String(init!.body));modelRequests.push(body);
  // Real elapsed slow-first-response regression: production must not inherit the
  // generic adapter's 10s deadline inside a 300s preparation run.
  if(modelRequests.length===1)await new Promise(r=>setTimeout(r,11000));
  const data=JSON.parse(body.messages[1].content),task=data.untrustedTask,p=task.preparation;
  for(const name of ['drive.list','drive.read','drive.create_artifact','image.inspect','image.crop_resize','document.inspect','document.overlay','document.render','ocr.document','ocr.render_regions','session.export','preparation.record_fields'])assert.ok(data.registeredTools.some((t:any)=>t.name===name),name);
  assert.equal(data.registeredTools.find((t:any)=>t.name==='image.inspect').effect,'write_local');
  let next:Decision;
  if(!p.fields.length){const user=p.sources.find((s:any)=>s.provider==='user');next={kind:'tool',name:'preparation.record_fields',args:{fields:[{id:'reference',label:'Reference',value:'000045',unresolved:false,citations:[{artifactId:user.snapshotArtifactId,sourceId:user.id,sourceVersion:user.sha256}]}]}};}
  else if(!task.observations.some((o:any)=>o.data?.listing)&&!task.observations.some((o:any)=>o.data?.code==='needs_discovery'))next={kind:'tool',name:'drive.read',args:{fileId:p.sources.find((s:any)=>s.provider==='user').snapshotArtifactId}};
  else if(!task.observations.some((o:any)=>o.data?.listing))next={kind:'tool',name:'drive.list',args:{folderId:'root'}};
  else if(!p.sources.some((s:any)=>s.providerId==='source'))next={kind:'tool',name:'drive.read',args:{fileId:'source'}};
  else if(!task.observations.some((o:any)=>o.data?.kind==='spindle.session-export.v1'&&o.data.revision===p.revision))next={kind:'tool',name:'session.export',args:{}};
  else next={kind:'ready',result:'Local draft prepared from invented selected sources. Nothing uploaded.'};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:next})}}],usage:{prompt_tokens:100,completion_tokens:40}});
 }});
 try{
  assert.equal(credentials,0);assert.equal(modelRequests.length,0);
  const client=new AccountClient(app.origin);await client.signin('invented-owner','invented-password-123',true);const config=await client.preparationConfiguration() as any;assert.equal(config.models.endpoint,'https://api.tokenfactory.nebius.com/v1/chat/completions');assert.equal(config.models.decision.modelId,decision.id);assert.equal(config.models.decision.inputContextTokens,65536);assert.equal(config.models.vision.maxOutputTokens,512);assert.equal(config.models.globalLimitUsd,3);assert.ok(config.models.maximumWholeTaskReservationUsd<=.3);assert.equal(config.limits.maximumDecisionCalls,16);assert.equal(config.limits.maximumVisionCalls,3);assert.equal(credentials,0);assert.ok(!JSON.stringify(config).includes('invented-nebius-key'));
  const flow=await client.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);await client.selectGoogleRoots(flow.connectionId,[selectedRoot]);
  const receipt=await client.prepareApplication({connectionId:flow.connectionId,rootId:selectedRoot,request:'!?!?! Please prepare a local draft. The user-provided reference is 000045. $(touch NEVER_EXECUTE)',requestId:'invented-request',processingConsent:true,saveOutputs:false});
  const settle=async()=>{for(let i=0;i<5000;i++){const t=await client.preparationTask(receipt.taskId);if(t.state!=='working')return t;await new Promise(r=>setTimeout(r,5));}throw Error('Production fixture did not settle');};
  const task=await settle();assert.equal(task.state,'ready',task.blocker);assert.equal(task.mode,'local_draft');assert.equal(task.outputs.length,0);assert.equal(task.fields[0]!.value,'000045');assert.equal(posts,0);assert.ok(task.artifacts.some(a=>a.bytes===source.length));assert.equal(credentials,6);
  const before=credentials;await client.correctPreparation({taskId:task.taskId,expectedRevision:1,fieldId:'reference',value:'000099'});const corrected=await settle();assert.equal(corrected.state,'ready',corrected.blocker);assert.equal(corrected.revision,2);assert.equal(corrected.fields[0]!.value,'000099');assert.equal(corrected.outputs.length,0);assert.equal(posts,0);assert.equal(credentials,before+2);
  const after=credentials;await client.preparationConfiguration();await client.preparationTask(task.taskId);assert.equal(credentials,after);
  assert.equal((await client.googleConnections()).connections[0]!.grants.includes('https://www.googleapis.com/auth/drive.file'),false);
 }finally{await app.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
