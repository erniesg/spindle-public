import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {scopes} from '../../core/connectors/google/oauth.js';
import type {PreparationConfig} from '../../core/preparation/service.js';

export async function statefulFixture(mode:'hold'|'block'='block'){
 const directory=await mkdtemp(join(tmpdir(),'sui-')),key=randomBytes(32),tasks=new AgentStore(join(directory,'tasks.sqlite')),store=new EvidenceStore(join(directory,'evidence'));
 let dispatches=0,writeGrant=false,parentAuthorized=false;const googleCalls:string[]=[];
 const google={clientId:'invented-client',clientSecret:'INVENTED_SECRET',picker:{appId:'123456789',developerKey:'INVENTED_BROWSER_KEY_123456789'},http:async(input:Parameters<typeof fetch>[0])=>{
  const u=new URL(String(input));googleCalls.push(u.pathname);
  if(u.pathname==='/token')return Response.json({access_token:'INVENTED_ACCESS',refresh_token:'INVENTED_REFRESH',scope:[scopes.mail,scopes.drive,...(writeGrant?['https://www.googleapis.com/auth/drive.file']:[])].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(u.pathname==='/drive/v3/files')return Response.json({files:[{id:'invented-file',name:'Invented source.txt',mimeType:'text/plain',version:'7'}]});
  if(u.pathname==='/drive/v3/files/root')return Response.json({id:'root',version:'1',mimeType:'application/vnd.google-apps.folder',parents:[],trashed:false,isAppAuthorized:parentAuthorized,capabilities:{canAddChildren:true}});
  if(u.pathname==='/drive/v3/files/invented-file')return u.searchParams.get('alt')==='media'?new Response('Invented source contents'):Response.json({id:'invented-file',name:'Invented source.txt',mimeType:'text/plain',version:'7',parents:['root'],trashed:false});
  throw Error('Unexpected invented Google path');
 }};
 const config:PreparationConfig={tasks,store,workspaceId:'account-private',buildIdentity:'invented-stateful-build',provider:()=>({id:'offline-stateful-fixture',next:async(_task,_tools,ctx)=>{dispatches++;if(mode==='hold')await new Promise<void>((_r,reject)=>{if(ctx?.signal.aborted)reject(Error('fixture stopped'));else ctx?.signal.addEventListener('abort',()=>reject(Error('fixture stopped')),{once:true});});throw Error('INVENTED_PREPARATION_BLOCKER');}}),tools:()=>[]};
 let server=await startTrackingServer(join(directory,'account'),key,0,undefined,google,config);
 const client=new AccountClient(server.origin);await client.signin('invented-owner','invented-password-123',true);
 const consent=async(url:string,denied=false)=>{const auth=new URL(url),callback=new URL(auth.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,...(denied?{error:'access_denied'}:{code:'invented-code'})}).toString();assert.equal((await fetch(callback)).status,denied?400:200);};
 const connect=async()=>{const flow=await client.connectGoogle();await consent(flow.authorizationUrl);await client.selectGoogleRoots(flow.connectionId,['root']);return flow.connectionId;};
 const connectionId=await connect();googleCalls.length=0;
 const input=(requestId='intent-one',request='Prepare an invented sourced draft')=>({connectionId,rootId:'root',request,requestId,processingConsent:true as const,saveOutputs:false});
 const wait=async(taskId:string,state?:string)=>{for(let n=0;n<200;n++){const t=await client.preparationTask(taskId) as any;if(state?t.state===state:t.state!=='working')return t;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture state did not settle');};
 return {get server(){return server;},client,tasks,store,directory,config,google,googleCalls,connectionId,input,connect,consent,wait,dispatches:()=>dispatches,setMode:(value:'hold'|'block')=>{mode=value;},setGrant:()=>{writeGrant=true;},setParent:()=>{parentAuthorized=true;},reopen:async()=>{await server.close();server=await startTrackingServer(join(directory,'account'),key,0,undefined,google,config);},close:async()=>{await server.close();tasks.close();store.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}
