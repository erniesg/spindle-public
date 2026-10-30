import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SharedGoogle} from '../../core/tracking/google.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {scopes} from '../../core/connectors/google/oauth.js';

function fixture(){
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/background-google-')),key=randomBytes(32);
 const row=()=>({id:'connection',incarnation:'incarnation',identity:'same@example.test',roots:['root'],rootRevision:1,credential:JSON.stringify({accountId:'same@example.test',connectionEpoch:'epoch',refreshToken:'INVENTED_REFRESH',grants:[scopes.mail,scopes.drive]})});
 const initial={accounts:[{id:'owner-a',google:[row()]},{id:'owner-b',google:[row()]}],sessions:{a:{account:'owner-a',expires:0},b:{account:'owner-b',expires:0}}};
 const store=new EncryptedStore(dir,key,()=>structuredClone(initial));let calls=0,held:(()=>void)|undefined,arrived:(()=>void)|undefined;
 const http:typeof fetch=async(_input,init)=>{calls++;assert.equal(new URLSearchParams(init?.body as URLSearchParams).get('client_secret'),'INVENTED_WEB_SECRET');arrived?.();if(held)await new Promise<void>(r=>{held=r;});return Response.json({access_token:'INVENTED_ACCESS'});};
 const config={clientId:'invented-web',clientSecret:'INVENTED_WEB_SECRET',http},origin=()=> 'http://127.0.0.1:12345';let google=new SharedGoogle(store,config,origin);
 return {store,get google(){return google;},calls:()=>calls,hold(){held=()=>{};return new Promise<void>(r=>{arrived=r;});},release(){held?.();held=undefined;},async reopen(){await google.close();google=new SharedGoogle(store,config,origin);},async close(){await google.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}};
}
test('explicit standing background authority reuses protected Web OAuth without browser-session lifetime, including host reopen',async()=>{
 const f=fixture();let authorized=true;const grant={ownerId:'owner-a',connectionId:'connection',isCurrent:()=>authorized};try{
  const cap=await f.google.triggerAuthority(grant),other=await f.google.triggerAuthority({ownerId:'owner-b',connectionId:'connection',isCurrent:()=>true});
  assert.notEqual(cap.workspaceId,other.workspaceId);assert.equal(cap.accountId,'same@example.test');assert.equal(cap.ownerId,'owner-a');assert.equal(f.calls(),0);
  await cap.assertCurrent(new AbortController().signal);const access=await cap.oauth.connectorAccess(cap.connectionId,scopes.mail);assert.equal(await access.token(),'INVENTED_ACCESS');assert.equal(f.calls(),1);
  await f.reopen();await assert.rejects(cap.assertCurrent(new AbortController().signal));const reopened=await f.google.triggerAuthority(grant);await reopened.assertCurrent(new AbortController().signal);
  authorized=false;await assert.rejects(reopened.assertCurrent(new AbortController().signal));await assert.rejects(reopened.oauth.connectorAccess(reopened.connectionId,scopes.mail));assert.equal(f.calls(),1);
  await assert.rejects(f.google.triggerAuthority({ownerId:'owner-b',connectionId:'connection',isCurrent:()=>false}));
 }finally{await f.close();}
});
test('background revocation during refresh cannot publish rotated credentials or survive connection/root changes',async()=>{
 const f=fixture();let authorized=true;const grant={ownerId:'owner-a',connectionId:'connection',isCurrent:()=>authorized};try{
  const cap=await f.google.triggerAuthority(grant),access=await cap.oauth.connectorAccess(cap.connectionId,scopes.mail);
  const before=await f.store.transaction(s=>s.accounts[0].google[0].credential,false),arrived=f.hold(),pending=access.token();const rejected=assert.rejects(pending);await arrived;authorized=false;f.release();await rejected;
  assert.equal(await f.store.transaction(s=>s.accounts[0].google[0].credential,false),before);
  authorized=true;await f.store.transaction(s=>{s.accounts[0].google[0].rootRevision++;});await assert.rejects(cap.assertCurrent(new AbortController().signal));
  const fresh=await f.google.triggerAuthority(grant);await f.store.transaction(s=>{s.accounts[0].google[0].incarnation='replacement';});await assert.rejects(fresh.assertCurrent(new AbortController().signal));
 }finally{f.release();await f.close();}
});
