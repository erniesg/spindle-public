import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
test('cancelled late credential lookup never starts token HTTP',async()=>{
 let release!:(value:string)=>void;let calls=0, writes=0;
 const pending=new Promise<string>(r=>release=r);
 const store={get:async()=>pending,set:async()=>{},delete:async()=>{},compareAndSet:async()=>{writes++;return true;}};
 const oauth=new GoogleOAuth('invented',store,async()=>{calls++;return Response.json({access_token:'access'});});
 const controller=new AbortController();
 const result=oauth.refresh('id',scopes.mail,undefined,undefined,{signal:controller.signal});
 controller.abort();release(JSON.stringify({refreshToken:'refresh',accountId:'invented@example.com',grants:[scopes.mail],connectionEpoch:'epoch'}));
 await assert.rejects(result);await new Promise(r=>setImmediate(r));assert.equal(calls,0);assert.equal(writes,0);
});
test('cancelled token body never commits refresh credentials',async()=>{
 let entered!:()=>void;const seen=new Promise<void>(r=>entered=r);let writes=0;
 const raw=JSON.stringify({refreshToken:'refresh',accountId:'invented@example.com',grants:[scopes.mail],connectionEpoch:'epoch'});
 const store={get:async()=>raw,set:async()=>{},delete:async()=>{},compareAndSet:async()=>{writes++;return true;}};
 const oauth=new GoogleOAuth('invented',store,async()=>new Response(new ReadableStream({start(){entered();}})));
 const controller=new AbortController();const result=oauth.refresh('id',scopes.mail,undefined,undefined,{signal:controller.signal});
 await seen;controller.abort();await assert.rejects(result);assert.equal(writes,0);
});
test('concurrent refreshes of one connection are serialized, so none loses the credential compare-and-set',async()=>{
 let stored=JSON.stringify({refreshToken:'refresh',accountId:'invented@example.com',grants:[scopes.mail],connectionEpoch:'epoch'});let inFlight=0,maxInFlight=0;
 const store={get:async()=>stored,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,next:string)=>{await new Promise(r=>setTimeout(r,5));if(stored!==expected)return false;stored=next;return true;}};
 const oauth=new GoogleOAuth('invented',store,async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return Response.json({access_token:'access'});});
 const tokens=await Promise.all(Array.from({length:6},()=>oauth.refresh('id',scopes.mail,'invented@example.com','epoch')));
 assert.deepEqual(tokens,Array(6).fill('access'));assert.equal(maxInFlight,1);
 // Fences still apply per queued refresh: an epoch change after earlier refreshes is refused, and the queue keeps working.
 await assert.rejects(oauth.refresh('id',scopes.mail,'invented@example.com','other-epoch'),/Connection epoch changed/);
 assert.equal(await oauth.refresh('id',scopes.mail,'invented@example.com','epoch'),'access');
});
test('queued refresh waiters keep their own authority: cancellation, account and grant are checked per caller',async()=>{
 const stored=JSON.stringify({refreshToken:'refresh',accountId:'invented@example.com',grants:[scopes.mail],connectionEpoch:'epoch'});let current=stored,calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const store={get:async()=>current,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,next:string)=>{if(current!==expected)return false;current=next;return true;}};
 const oauth=new GoogleOAuth('invented',store,async()=>{calls++;if(calls===1)await gate;return Response.json({access_token:'access'});});
 const first=oauth.refresh('id',scopes.mail,'invented@example.com','epoch');
 const controller=new AbortController();const cancelled=oauth.refresh('id',scopes.mail,'invented@example.com','epoch',{signal:controller.signal});
 const wrongAccount=oauth.refresh('id',scopes.mail,'someone-else@example.com','epoch');
 const wrongGrant=oauth.refresh('id',scopes.drive,'invented@example.com','epoch');
 controller.abort();await assert.rejects(cancelled);assert.equal(calls,1,'the cancelled waiter rejected while queued without token HTTP');
 release();assert.equal(await first,'access');
 await assert.rejects(wrongAccount,/account mismatch/);await assert.rejects(wrongGrant,/Required grant absent/);
 assert.equal(calls,1,'refused waiters never reached token HTTP');
 assert.equal(await oauth.refresh('id',scopes.mail,'invented@example.com','epoch'),'access');assert.equal(calls,2);
});
test('serialization spans GoogleOAuth instances for the same connection (bindings, account page, mail)',async()=>{
 let stored=JSON.stringify({refreshToken:'refresh',accountId:'invented@example.com',grants:[scopes.mail],connectionEpoch:'epoch'});let inFlight=0,maxInFlight=0;
 const store={get:async()=>stored,set:async()=>{},delete:async()=>{},compareAndSet:async(_id:string,expected:string|undefined,next:string)=>{await new Promise(r=>setTimeout(r,5));if(stored!==expected)return false;stored=next;return true;}};
 const http=async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return Response.json({access_token:'access'});};
 const a=new GoogleOAuth('invented',store,http),b=new GoogleOAuth('invented',store,http);
 const tokens=await Promise.all([a,b,a,b].map(o=>o.refresh('shared-id',scopes.mail,'invented@example.com','epoch')));
 assert.deepEqual(tokens,Array(4).fill('access'));assert.equal(maxInFlight,1);
});
