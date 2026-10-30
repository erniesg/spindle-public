import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';

for (const action of ['disconnect','replacement'] as const) test(`late refresh cannot undo ${action} across OAuth instances`,async()=>{
 let saved:string|undefined=JSON.stringify({refreshToken:'old-invented',accountId:'demo@example.test',grants:[scopes.mail]});
 const store={compareAndDelete:async(_id:string,expected:string)=>{if(saved!==expected)return false;saved=undefined;return true;},get:async()=>saved,set:async(_id:string,value:string)=>{saved=value;},delete:async()=>{saved=undefined;},compareAndSet:async(_id:string,expected:string|undefined,value:string)=>{if(saved!==expected)return false;saved=value;return true;}};
 let release!:(r:Response)=>void,started!:()=>void;
 const ready=new Promise<void>(r=>{started=r;});
 const pending=new Promise<Response>(r=>{release=r;});
 const first=new GoogleOAuth('invented-client',store,(async()=>{started();return pending;}) as typeof fetch);
 const second=new GoogleOAuth('invented-client',store,(async(url)=>String(url).includes('/profile')?Response.json({emailAddress:'demo@example.test'}):Response.json({access_token:'new-access',refresh_token:'replacement-invented',scope:scopes.mail})) as typeof fetch);
 const refresh=first.refresh('demo',scopes.mail);await ready;
 if(action==='disconnect')await second.disconnect('demo',false);
 else {const flow=second.begin(12345,[scopes.mail]);await second.exchange(`${flow.redirect}?state=${flow.state}&code=invented`,flow,'demo');}
 const expected=saved;
 release(Response.json({access_token:'late-access',refresh_token:'late-invented'}));
 await assert.rejects(refresh,/Connection changed/);
 assert.equal(saved,expected);
 if(action==='disconnect')assert.equal(saved,undefined);
 else assert.equal(JSON.parse(saved!).refreshToken,'replacement-invented');
});
