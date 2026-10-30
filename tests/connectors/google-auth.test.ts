import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
test('verified identity binds reconnect; partial grants survive restart and rotation',async()=>{
 let saved:string|undefined;let identity='first@example.test';let calls=0;
 const store={get:async()=>saved,set:async(_id:string,value:string)=>{saved=value;},delete:async()=>{saved=undefined;},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(saved!==expected)return false;saved=value;return true;}};
 const http=(async(url,init)=>{calls++;if(String(url).includes('/profile'))return Response.json({emailAddress:identity});const refresh=String(init?.body).includes('refresh_token');return Response.json(refresh?{access_token:'access-2',refresh_token:'rotated'}:{access_token:'access-1',refresh_token:'refresh-1',scope:scopes.mail});}) as typeof fetch;
 const oauth=new GoogleOAuth('invented',store,http);
 const connect=async(expected?:string)=>{const f=oauth.begin(12345,[scopes.mail,scopes.drive]);return oauth.exchange(`${f.redirect}?state=${f.state}&code=invented`,f,'connection',expected);};
 const first=await connect('first@example.test');assert.equal(first.accountId,identity);assert.deepEqual(first.missingGrants,[scopes.drive]);
 const original=saved;identity='other@example.test';await assert.rejects(connect(),/account mismatch/);assert.equal(saved,original);
 const restarted=new GoogleOAuth('invented',store,http);assert.deepEqual(await restarted.status('connection'),{accountId:'first@example.test',grants:[scopes.mail]});
 const before=calls;await assert.rejects(restarted.accessToken('connection',scopes.drive),/grant absent/);assert.equal(calls,before);
 assert.equal(await restarted.accessToken('connection',scopes.mail),'access-2');assert.equal(JSON.parse(saved!).refreshToken,'rotated');assert.deepEqual(JSON.parse(saved!).grants,[scopes.mail]);
 await assert.rejects(restarted.accessToken('connection',scopes.drive),/grant absent/);
});
test('unverifiable identity and invalid token cannot replace connection',async()=>{
 for(const response of [{access_token:4},{access_token:'access',refresh_token:'refresh',scope:scopes.drive}]){
 let saved:string|undefined;
 const oauth=new GoogleOAuth('invented',{get:async()=>saved,set:async(_id,v)=>{saved=v;},delete:async()=>{},compareAndSet:async()=>{throw Error('unexpected write');}},(async()=>Response.json(response)) as typeof fetch);
 const f=oauth.begin(12345,[scopes.drive]);await assert.rejects(oauth.exchange(`${f.redirect}?state=${f.state}&code=x`,f,'demo'));assert.equal(saved,undefined);
 }
});

test('bound connector rejects account replacement between check and refresh read',async()=>{
 const a=JSON.stringify({accountId:'a@example.test',refreshToken:'refresh-a',grants:[scopes.mail]});
 const b=JSON.stringify({accountId:'b@example.test',refreshToken:'refresh-b',grants:[scopes.mail]});
 let reads=0,calls=0,writes=0;
 const oauth=new GoogleOAuth('invented',{
  get:async()=>++reads<=2?a:b,
  set:async()=>{throw Error('unexpected set');},delete:async()=>{throw Error('unexpected delete');},
  compareAndSet:async(_id,expected)=>{writes++;assert.equal(expected,b);return true;}
 },(async()=>{calls++;return Response.json({access_token:'access-b'});}) as typeof fetch);
 const connector=await oauth.connectorAccess('connection',scopes.mail);
 assert.equal(connector.accountId,'a@example.test');
 await assert.rejects(connector.token(),/account mismatch/);
 assert.equal(reads,3);assert.equal(calls,0);assert.equal(writes,0);
});
