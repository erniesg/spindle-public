import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,lstat,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startPreparationAccount,type PreparationAccountConfig} from '../../core/preparation/startup.js';

// Scripted transports only; no runtime environment/configuration or paid journals.
async function fixture(){
 await mkdir('.local/owned-pilot-tests',{recursive:true});const dir=await mkdtemp(join(process.cwd(),'.local/owned-pilot-tests/startup-')),key=randomBytes(32);let calls=0;
 const model={provider:'nebius' as const,id:'invented',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:.06,outputUsdPerMillion:.24,verifiedAt:'2026-10-26T00:00:00Z',source:'https://example.test/invented-pricing'}};
 const config:PreparationAccountConfig={directory:join(dir,'account'),key,publicOrigin:'https://pilot.example.test',publicProxy:{token:'a'.repeat(64)},budgetPath:join(dir,'invented-budget.json'),google:{clientId:'invented',clientSecret:'invented',http:async()=>{calls++;throw Error('No Google dispatch authorized');}},decisionModel:model,visionModel:{...model,images:{inputTokensUpperBound:16000,accounting:'input-tokens'}},credential:async()=>{calls++;throw Error('No credentials authorized');},modelTransport:async()=>{calls++;throw Error('No provider dispatch authorized');},buildIdentity:'invented-startup',sourceIdentity:{revision:'a'.repeat(40),tree:'b'.repeat(40)}};
 return {dir,config,calls:()=>calls,close:async()=>{key.fill(0);await rm(dir,{recursive:true,force:true});}};
}
const missing=async(path:string)=>assert.rejects(lstat(path),(e:any)=>e.code==='ENOENT');
test('public full-Google default is connection-only with mail off; no budget, Task owner, local agent store or provider initialization',async()=>{
 const f=await fixture();try{
  for(const google of [f.config.google,undefined]){
   const server=await startPreparationAccount({...f.config,google});try{await missing(join(f.config.directory,'preparation'));assert.equal(f.calls(),0);await missing(f.config.budgetPath);}finally{await server.close();}
  }
  // Private loopback remains covered by the existing production-startup suite.
 }finally{await f.close();}
});
test('malformed pilot config and connection-only mail enable fail before listener or account-store mutation',async()=>{
 const f=await fixture();try{
  for(const publicPaidAccess of [null,{},Object.assign(Object.create({mode:'connection-only'}),{unexpected:true}), {mode:'owned-pilot'}, {mode:'connection-only',accountId:'forged'}, {mode:'owned-pilot',accountId:'not-uuid',scopeId:'invented'}, {mode:'owned-pilot',accountId:'11111111-1111-4111-8111-111111111111',scopeId:''}]){
   await assert.rejects(startPreparationAccount({...f.config,publicPaidAccess} as any),/PUBLIC_PAID_ACCESS_INVALID/);await missing(f.config.directory);
  }
  for(const publicPaidAccess of [undefined,{mode:'connection-only'} as const]){
   await assert.rejects(startPreparationAccount({...f.config,publicPaidAccess,mailEnabled:true}),/PUBLIC_PILOT_MAIL_DISABLED/);await missing(f.config.directory);
  }
  assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('explicit owned pilot startup constructs only inert local preparation stores, defaults mail off, and never auto-resumes',async()=>{
 const f=await fixture();try{
  await writeFile(f.config.budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
  const config={...f.config,publicPaidAccess:{mode:'owned-pilot' as const,accountId:'11111111-1111-4111-8111-111111111111',scopeId:'invented'}};
  for(let n=0;n<2;n++){const server=await startPreparationAccount(config);try{assert.ok((await lstat(join(f.config.directory,'preparation','tasks.sqlite'))).isFile());assert.equal(f.calls(),0);}finally{await server.close();}}
 }finally{await f.close();}
});
