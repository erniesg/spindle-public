import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {interpretCredentialExit} from '../../core/connectors/google/credentials.js';
test('credential helper distinguishes absent lookup from unavailable backend',()=>{
 assert.equal(interpretCredentialExit({code:1,stdout:'',stderr:''},true),'');
 assert.equal(interpretCredentialExit({code:0,stdout:'value\n',stderr:''},false),'value');
 for(const result of [{code:1,stdout:'',stderr:'locked'},{code:1,stdout:'partial',stderr:''},{code:2,stdout:'',stderr:''},{code:null,stdout:'',stderr:''}]) assert.throws(()=>interpretCredentialExit(result,true),/failed/);
 assert.throws(()=>interpretCredentialExit({code:1,stdout:'',stderr:''},false),/failed/);
});
test('OAuth token and profile streams are capped before validation and carry timeout signals',async()=>{
 for(const oversized of ['token','profile']){
 let saved=false;
 const http=(async(url,init)=>{
 assert.ok(init?.signal instanceof AbortSignal);
 if((String(url).includes('/profile')?'profile':'token')===oversized)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));c.close();}}));
 return Response.json({access_token:'a',refresh_token:'r',scope:scopes.mail});
 }) as typeof fetch;
 const oauth=new GoogleOAuth('invented',{get:async()=>undefined,set:async()=>{},delete:async()=>{},compareAndSet:async()=>{saved=true;return true;}},http);
 const flow=oauth.begin(12345,[scopes.mail]);
 await assert.rejects(oauth.exchange(`${flow.redirect}?state=${flow.state}&code=x`,flow,'invented'),/byte limit/);
 assert.equal(saved,false);
 }
});
