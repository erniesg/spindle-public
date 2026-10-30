import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {LinuxCredentialStore,interpretCredentialExit} from '../../core/connectors/google/credentials.js';

test('legacy JSON without grants is unsupported and never revoked or deleted',async()=>{
 let calls=0;const oauth=new GoogleOAuth('invented',{get:async()=>JSON.stringify({refreshToken:'invented',accountId:'demo@example.test'}),set:async()=>{},delete:async()=>{calls++;},compareAndSet:async()=>false,compareAndDelete:async()=>{calls++;return true;}},(async()=>{calls++;return new Response();}) as typeof fetch);
 await assert.rejects(oauth.disconnect('demo'),/invalid protected connection/);assert.equal(calls,0);
});

for(const legacy of [true,false])for(const change of ['refresh','reconnect'] as const)test(`disconnect ${legacy?'legacy':'explicit'} record during ${change} uses production locked identity`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy13-'));let saved:string|undefined=JSON.stringify({refreshToken:'invented-old',accountId:'Demo@example.test',grants:[scopes.mail],...(legacy?{}:{connectionEpoch:'original'})});
 class Store extends LinuxCredentialStore {protected override async run(args:string[],input?:string){if(args[0]==='lookup')return interpretCredentialExit({code:saved?0:1,stdout:saved??'',stderr:''},true);if(args[0]==='store')saved=input;if(args[0]==='clear')saved=undefined;return '';}}
 let release!:(r:Response)=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r);const pending=new Promise<Response>(r=>release=r);
 const store=new Store(root);const http=(async(url:unknown)=>{if(String(url).includes('/revoke')){ready();return pending;}return Response.json({access_token:'invented-access',refresh_token:'invented-rotated'});}) as typeof fetch;
 const oauth=new GoogleOAuth('invented',store,http);
 try{const result=oauth.disconnect('demo');const outcome=result.then(()=>undefined,error=>error);await started;
 if(change==='refresh')await new GoogleOAuth('invented',new Store(root),http).refresh('demo',scopes.mail);
 else await new Store(root).compareAndSet('demo',saved,JSON.stringify({refreshToken:'invented-new',accountId:'demo@example.test',grants:[scopes.mail],connectionEpoch:'new-exchange'}));
 release(new Response(null,{status:200}));const error=await outcome;
 if(change==='refresh'){assert.equal(error,undefined);assert.equal(saved,undefined);}else{assert.match(String(error),/Connection changed/);assert.equal(JSON.parse(saved!).connectionEpoch,'new-exchange');}
 }finally{release?.(new Response(null,{status:200}));await rm(root,{recursive:true,force:true});}
});
