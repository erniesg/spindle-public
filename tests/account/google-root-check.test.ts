import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {scopes} from '../../core/connectors/google/oauth.js';

async function fixture(){
 const directory=await mkdtemp(join(process.cwd(),'.local/shared-google/root-check-')),key=randomBytes(32),calls:URL[]=[];
 let mimeType='application/vnd.google-apps.folder',trashed=false,arrive:(()=>void)|undefined,release:(()=>void)|undefined;
 let held:Promise<void>|undefined;
 const http:typeof fetch=async(input)=>{
  const u=new URL(String(input));calls.push(u);
  if(u.pathname==='/token')return Response.json({access_token:'invented-access',refresh_token:'invented-refresh',scope:[scopes.mail,scopes.drive].join(' ')});
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'invented@example.test'});
  if(u.pathname==='/drive/v3/files/root'){
   arrive?.();if(held)await held;
   return Response.json({id:'root',mimeType,trashed,version:'v1'});
  }
  throw Error('Unexpected provider call: only selected folder metadata is allowed');
 };
 const server=await startTrackingServer(directory,key,0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http});
 const a=new AccountClient(server.origin),b=new AccountClient(server.origin),other=new AccountClient(server.origin);
 await a.signin('invented-owner','invented-password-123',true);await b.signin('invented-owner','invented-password-123');await other.signin('invented-other','invented-password-123',true);
 const flow=await a.connectGoogle(),auth=new URL(flow.authorizationUrl),callback=new URL(auth.searchParams.get('redirect_uri')!);
 callback.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'invented-code'}).toString();assert.equal((await fetch(callback)).status,200);
 await a.selectGoogleRoots(flow.connectionId,['root']);calls.length=0;
 const check=(client=a,rootId='root')=>client.request('/google/drive/check',{connectionId:flow.connectionId,rootId});
 return {a,b,other,calls,flow,check,set:(mime:string,deleted:boolean)=>{mimeType=mime;trashed=deleted;},hold:()=>{const arrived=new Promise<void>(r=>{arrive=r;});held=new Promise<void>(r=>{release=r;});return {arrived,release:()=>release?.()};},close:async()=>{release?.();await server.close();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}
test('selected-root access check uses only minimal folder metadata, never children or content',async()=>{
 const f=await fixture();try{
  const result=await f.check(f.b) as any;
  assert.equal(result.providerId,'root');assert.equal(result.providerVersion,'v1');assert.equal(result.mimeType,'application/vnd.google-apps.folder');assert.equal(result.provenance.connectionId,f.flow.connectionId);
  const drive=f.calls.filter(u=>u.hostname==='www.googleapis.com');assert.equal(drive.length,1);assert.equal(drive[0]!.pathname,'/drive/v3/files/root');
  assert.deepEqual(drive[0]!.searchParams.get('fields')!.split(',').sort(),['id','mimeType','name','trashed','version'].sort());assert.equal(drive[0]!.searchParams.get('alt'),null);assert.ok(!JSON.stringify(result).includes('invented-access'));
 }finally{await f.close();}
});
test('root check denies wrong owner/unselected root before any Google request',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.check(f.other));await assert.rejects(f.check(f.a,'unselected'));assert.equal(f.calls.length,0);
  await assert.rejects(f.a.request('/google/drive/check',{connectionId:f.flow.connectionId,rootId:'root',fileId:'personal-file'}));assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test('root check rejects nonfolder/trash and a root removed during metadata retrieval',async()=>{
 const f=await fixture();try{
  await f.check();
  f.set('application/pdf',false);await assert.rejects(f.check());f.set('application/vnd.google-apps.folder',true);await assert.rejects(f.check());
  f.set('application/vnd.google-apps.folder',false);const held=f.hold(),check=f.check(f.b),denied=assert.rejects(check);await held.arrived;await f.a.selectGoogleRoots(f.flow.connectionId,[]);held.release();await denied;
 }finally{await f.close();}
});
