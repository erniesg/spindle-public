import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';

for(const stage of ['expiry','profile-body'] as const)test(`real loopback ${stage} cancels pending exchange without late CAS`,async()=>{
 let release!:()=>void,ready!:()=>void;let writes=0,bodyCancelled=false;
 const started=new Promise<void>(r=>ready=r),latch=new Promise<void>(r=>release=r);
 const store={get:async()=>undefined,set:async()=>{},delete:async()=>{},compareAndSet:async()=>{writes++;return true;}};
 const oauth=new GoogleOAuth('invented',store,(async url=>{
  if(!String(url).includes('/profile')){
   if(stage==='expiry'){ready();await latch;}
   return Response.json({access_token:'a',refresh_token:'r',scope:scopes.mail});
  }
  return new Response(new ReadableStream<Uint8Array>({start(controller){
   controller.enqueue(new TextEncoder().encode('{"emailAddress":'));
   void latch.then(()=>{if(!bodyCancelled){controller.enqueue(new TextEncoder().encode('"demo@example.test"}'));controller.close();}});
  },pull(){ready();return latch;},cancel(){bodyCancelled=true;}}));
 }) as typeof fetch);
 const listener=await oauth.listen([scopes.mail],'demo',undefined,{timeoutMs:stage==='expiry'?200:2000});
 const deadline=AbortSignal.timeout(3000);
 const request=fetch(`${listener.flow.redirect}?state=${listener.flow.state}&code=invented`,{signal:deadline}).then(r=>r.text()).catch(()=>undefined);
 try{
  await Promise.race([started,new Promise<never>((_,reject)=>deadline.addEventListener('abort',()=>reject(deadline.reason),{once:true}))]);
  if(stage==='profile-body')await listener.close();
  await assert.rejects(listener.result,stage==='expiry'?/^Error: OAuth flow expired$/:/^Error: OAuth listener closed$/);
  await request;
  release();await new Promise(r=>setImmediate(r));
  assert.equal(writes,0);
  if(stage==='profile-body')assert.equal(bodyCancelled,true);
 }finally{release();await listener.close();await request;}
});
