import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';
import { boundedBytes } from '../../core/connectors/google/bounded.js';
import { DriveReader } from '../../core/connectors/google/drive.js';
test('OAuth rejects wrong state before network; refresh and revoke use protected store',async()=>{
 let secret:string|undefined=JSON.stringify({refreshToken:'invented-refresh',accountId:'demo@example.test',grants:[scopes.mail]}),calls=0;
 const store={compareAndDelete:async(_id:string,expected:string)=>{if(secret!==expected)return false;secret=undefined;return true;},get:async()=>secret,set:async(_id:string,v:string)=>{secret=v;},delete:async()=>{secret=undefined;},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(secret!==expected)return false;secret=value;return true;}};
 const http=(async()=>{calls++;return new Response(JSON.stringify({access_token:'invented-access'}));}) as typeof fetch;
 const oauth=new GoogleOAuth('invented-client',store,http),flow=oauth.begin(12345,['mail']);
 await assert.rejects(oauth.exchange(`${flow.redirect}?state=wrong&code=x`,flow,'demo'));assert.equal(calls,0);
 assert.equal(await oauth.refresh('demo',scopes.mail),'invented-access');await oauth.disconnect('demo');assert.equal(secret,undefined);assert.equal(calls,2);
});
test('Drive rejects malformed root metadata even if selected',async()=>{
 const http=(async()=>Response.json({id:'selected',mimeType:'image/png',version:'1',parents:[],trashed:false})) as typeof fetch;
 await assert.rejects(new DriveReader('invented','demo',new Set(['selected']),http).read('selected'),/selected Drive root/);
});
test('chunked bytes are cancelled at the configured cap',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){cancelled=true;}}));
 await assert.rejects(boundedBytes(response,10),/byte limit/);assert.equal(cancelled,true);
});
test('Drive refuses unselected files without downloading bytes',async()=>{
 const http=(async()=>new Response(JSON.stringify({id:'outside',parents:[],mimeType:'image/png',version:'1',trashed:false}))) as typeof fetch;
 await assert.rejects(new DriveReader('invented','demo',new Set(['selected']),http).read('outside'),/Outside selected/);
});
