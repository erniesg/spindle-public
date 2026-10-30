import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {LinuxCredentialStore,interpretCredentialExit} from '../../core/connectors/google/credentials.js';

test('disconnect deletes same epoch refreshed during revocation through production lock predicate',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oauth12-'));let saved:string|undefined=JSON.stringify({refreshToken:'old',accountId:'demo@example.test',connectionEpoch:'epoch',grants:[scopes.mail]});
 class Store extends LinuxCredentialStore {protected override async run(args:string[],input?:string){if(args[0]==='lookup')return interpretCredentialExit({code:saved?0:1,stdout:saved??'',stderr:''},true);if(args[0]==='store')saved=input;if(args[0]==='clear')saved=undefined;return '';}}
 let release!:(r:Response)=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r);const pending=new Promise<Response>(r=>release=r);
 const store=new Store(root);const oauth=new GoogleOAuth('invented',store,(async()=>{ready();return pending;}) as typeof fetch);
 try{const result=oauth.disconnect('demo');await started;const before=saved;await new Store(root).compareAndSet('demo',before,JSON.stringify({...JSON.parse(before!),refreshToken:'rotated',generation:'new'}));release(new Response(null,{status:200}));await result;assert.equal(saved,undefined);}finally{await rm(root,{recursive:true,force:true});}
});

for(const stage of ['lookup','token','profile'] as const)test(`listener close cancels stalled ${stage} without late persistence`,async()=>{
 let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>ready=r);const latch=new Promise<void>(r=>release=r);let writes=0;
 const store={get:async()=>{if(stage==='lookup'){ready();await latch;}return undefined;},set:async()=>{},delete:async()=>{},compareAndSet:async()=>{writes++;return true;}};
 const oauth=new GoogleOAuth('invented',store,(async url=>{const profile=String(url).includes('/profile');if((stage==='token'&&!profile)||(stage==='profile'&&profile)){ready();await latch;}return Response.json(profile?{emailAddress:'demo@example.test'}:{access_token:'a',refresh_token:'r',scope:scopes.mail});}) as typeof fetch);
 const listener=await oauth.listen([scopes.mail],'demo');const request=fetch(`${listener.flow.redirect}?state=${listener.flow.state}&code=invented`).catch(()=>undefined);
 await started;await listener.close();await assert.rejects(listener.result,/closed/);release();await request;await new Promise(r=>setImmediate(r));assert.equal(writes,0);
});
