import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LinuxCredentialStore} from '../../core/connectors/google/credentials.js';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';

test('revocation paused across instances cannot delete a reconnected protected record',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spindle-disconnect-'));
 let saved:string|undefined=JSON.stringify({refreshToken:'old-invented',accountId:'demo@example.test',grants:[scopes.mail],connectionEpoch:'old-epoch'});
 class FakeSecretService extends LinuxCredentialStore {
  protected override async run(args:string[],input?:string){
   if(args[0]==='lookup')return saved??'';
   if(args[0]==='store')saved=input;
   if(args[0]==='clear')saved=undefined;
   return '';
  }
 }
 let release!:(value:Response)=>void,started!:()=>void;
 const ready=new Promise<void>(r=>{started=r;});
 const pending=new Promise<Response>(r=>{release=r;});
 const first=new GoogleOAuth('invented',new FakeSecretService(root),(async(_url,init)=>{assert.equal(new URLSearchParams(init?.body as URLSearchParams).get('token'),'old-invented');started();return pending;}) as typeof fetch);
 const second=new GoogleOAuth('invented',new FakeSecretService(root),(async url=>String(url).includes('/profile')?Response.json({emailAddress:'demo@example.test'}):Response.json({access_token:'access',refresh_token:'fresh-invented',scope:scopes.mail})) as typeof fetch);
 try {
  const disconnect=first.disconnect('demo');await ready;
  const flow=second.begin(12345,[scopes.mail]);await second.exchange(`${flow.redirect}?state=${flow.state}&code=invented`,flow,'demo');
  const fresh=saved;assert.notEqual(JSON.parse(fresh!).connectionEpoch,'old-epoch');
  release(new Response(null,{status:200}));await assert.rejects(disconnect,/Connection changed during disconnect/);
  assert.equal(saved,fresh);assert.equal(JSON.parse(saved!).refreshToken,'fresh-invented');
 }finally{release?.(new Response(null,{status:200}));await rm(root,{recursive:true,force:true});}
});

test('disconnect without atomic deletion fails closed before revocation',async()=>{
 let calls=0,deletes=0;
 const oauth=new GoogleOAuth('invented',{get:async()=>JSON.stringify({refreshToken:'invented',accountId:'demo@example.test',grants:[scopes.mail]}),set:async()=>{},delete:async()=>{deletes++;},compareAndSet:async()=>true},(async()=>{calls++;return new Response(null,{status:200});}) as typeof fetch);
 await assert.rejects(oauth.disconnect('demo'),/Atomic credential deletion unavailable/);
 assert.equal(calls,0);assert.equal(deletes,0);
});
