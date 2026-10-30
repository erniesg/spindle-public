import {test} from 'node:test';
import {quotaServices} from './paid-task-quota-services.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {AgentProvider,ToolDefinition} from '../../core/agent/contracts.js';

for(const quotaMode of [true,false])test((quotaMode?'generic N4 services with private HTTP auth':'private account HTTP')+' preparation plus separate mail task preserves multi-call execution and replay',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'spindle-quota-http-invented-')),key=randomBytes(32),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
 let prepCalls=0,mailCalls=0;
 const google:typeof fetch=async(input)=>{
  const u=new URL(String(input));if(u.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'sender@example.test'});
  throw Error('Unexpected invented Google route');
 };
 const noop:ToolDefinition={name:'document.inspect',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse:v=>v},outputSchema:{jsonSchema:{type:'object'},parse:v=>v},async invoke(_args,ctx){return {callId:ctx.callId,status:'ok',data:{invented:true},artifacts:[],evidence:[],observations:[]};}};
 const prep:AgentProvider={id:'invented-preparation',async next(t){prepCalls++;return t.observations.length<2?{kind:'tool',name:noop.name,args:{}}:{kind:'ready',result:'Invented local preparation'};}};
 const mail:AgentProvider={id:'invented-mail',async next(t){mailCalls++;return Object.keys(t.mail?.drafts??{}).length?{kind:'ready',result:'Invented local draft retained'}:{kind:'tool',name:'mail.draft.create',args:{content:{to:[{address:'recipient@example.test'}],subject:'Invented preparation',text:'Invented only'},provenanceIds:[]}};}};
 const googleConfig={clientId:'invented-client',clientSecret:'invented-secret',http:google},prepConfig={tasks,store,workspaceId:'account-private',buildIdentity:'invented',provider:()=>prep,tools:()=>[noop]},mailConfig={tasks,store,workspaceId:'account-private',provider:()=>mail};
 const services=quotaMode?await quotaServices(join(directory,'account'),key,googleConfig,prepConfig,mailConfig):undefined;
 const server=services??await startTrackingServer(join(directory,'account'),key,0,undefined,googleConfig,prepConfig,mailConfig);
 const transport=services?.transport??fetch,client=services?.client??new AccountClient(server.origin,transport);
 const serviceRequest=(path:string,data:Record<string,unknown>)=>services?services.request(path,data):client.request(path,data);
 const wait=async(id:string,path:string)=>{for(let n=0;n<100;n++){const s=await serviceRequest(path,{taskId:id}) as any;if(s.state!=='working')return s;await new Promise(r=>setTimeout(r,5));}throw Error('Invented runtime did not finish');};
 try{
  await client.signin('invented-quota-owner','invented-password-123',true);
  const flow=await client.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();
  assert.equal((await transport(callback)).status,200);
  await client.request('/google/roots',{connectionId:flow.connectionId,roots:['root']});
  const request={connectionId:flow.connectionId,rootId:'root',request:'Invented photo and form preparation',requestId:'preparation-one',processingConsent:true,saveOutputs:false};
  const p=await serviceRequest('/preparation/request',request) as any,prepared=await wait(p.taskId,'/preparation/status');
  // Ready without a session export is rejected as model feedback (READY_REJECTED) and the run continues to its turn bound.
  const prepTurns=prepCalls;assert.ok(prepTurns>3,String(prepTurns));assert.equal(prepared.state,'blocked');assert.ok(tasks.get(p.taskId).observations.some(o=>o.error?.code==='READY_REJECTED'));
  const mailRequest={connectionId:flow.connectionId,request:'Draft a separate invented email',requestId:'mail-two',processingConsent:true};
  const m=await serviceRequest('/mail/request',mailRequest) as any;const draft=await wait(m.taskId,'/mail/status');assert.equal(mailCalls,2);assert.equal(draft.drafts.length,1);
  assert.equal((await serviceRequest('/preparation/request',{...request,requestId:'retained-alias'}) as any).taskId,p.taskId);
  assert.equal((await serviceRequest('/mail/request',mailRequest) as any).taskId,m.taskId);
  assert.equal(prepCalls,prepTurns,'replay adds no model calls');assert.equal(mailCalls,2);
  await serviceRequest('/mail/cancel',{taskId:m.taskId});
  const third=()=>serviceRequest('/mail/request',{...mailRequest,requestId:'third-new-task'});
  if(quotaMode){await assert.rejects(third(),(e:any)=>e.status===429&&e.message==='PAID_TASK_QUOTA');assert.equal(mailCalls,2);assert.equal(tasks.tasks({workspaceId:'account-private',accountId:client.account!.id}).length,2);}
  else{const admitted=await third() as any;await wait(admitted.taskId,'/mail/status');assert.equal(mailCalls,4);}
 }finally{await server.close();store.close();tasks.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
