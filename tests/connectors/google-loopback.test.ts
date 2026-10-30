import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';
test('real loopback rejects untrusted origin, consumes state once, tracks partial grants', async()=>{
 let calls=0;
 const store={get:async()=>undefined,set:async()=>{},delete:async()=>{},compareAndSet:async()=>true};
 const http=(async(url)=>{calls++;return new Response(JSON.stringify(String(url).includes('/profile')?{emailAddress:'demo@example.test'}:{access_token:'invented',refresh_token:'invented',scope:scopes.mail}));}) as typeof fetch;
 const oauth=new GoogleOAuth('invented',store,http);
 const listener=await oauth.listen([scopes.mail,scopes.drive],'demo');
 try {
 const callback=`${listener.flow.redirect}?state=${listener.flow.state}&code=invented`;
 assert.equal((await fetch(callback,{headers:{Origin:'https://evil.invalid'}})).status,403);
 assert.equal(calls,0);
 assert.equal((await fetch(callback)).status,200);
 const result=await listener.result;
 assert.deepEqual(result.missingGrants,[scopes.drive]);
 assert.deepEqual(result.grants,[scopes.mail]);
 assert.equal((await fetch(callback)).status,409);
 assert.equal(calls,2);
 } finally {await listener.close();}
});
test('expired and replayed flow cannot exchange credentials',async()=>{
 const store={get:async()=>undefined,set:async()=>{},delete:async()=>{},compareAndSet:async()=>{throw Error('unexpected write');}};
 const oauth=new GoogleOAuth('invented',store, (async()=>{throw Error('must not call');}) as typeof fetch);
 const flow=oauth.begin(12345,['mail']);flow.expiresAt=0;
 await assert.rejects(oauth.exchange(`${flow.redirect}?state=${flow.state}&code=x`,flow,'demo'),/expired/);
});
