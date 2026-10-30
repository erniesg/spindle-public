import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreviewWorkOSControl} from '../../core/preview/workos-control.js';
import type {DesktopWorkOSCallback} from '../../core/account/workos-desktop.js';
const origin='http://127.0.0.1:43167',account={id:'12345678-1234-1234-1234-123456789abc',name:'workos-invented'};
const session=(letter:string)=>({account,cookie:'spindle_session='+letter.repeat(64),csrf:letter.repeat(64)});
const credentials={account,tracking:session('a'),timer:session('b')};
function fixture(){
 let resolve!:(value:DesktopWorkOSCallback)=>void,cancelled=0,adopted=0,live=true,revokeFail=false,adoptFail=false,persistFail=false;
 const callback=new Promise<DesktopWorkOSCallback>(r=>resolve=r),revoked:string[]=[],requests:string[]=[];
 let config:unknown={configured:true,clientId:'client_invented',backendOrigin:origin};
 let exchange:()=>Promise<Response>=async()=>Response.json(credentials);
 const transport:typeof fetch=async(input)=>{requests.push(String(input));return String(input).endsWith('/config')?Response.json(config):exchange();};
 const control=new PreviewWorkOSControl({persistCleanup:async()=>{if(persistFail)throw Error('DISK_UNCERTAIN');},transport,start:async()=>({authorizationUrl:'https://api.workos.com/user_management/authorize?state=secret-state',callback,cancel:async()=>{cancelled++;}}),adopt:async(_origin,_device,_sessions,check)=>{check();if(adoptFail)throw Error('ADOPTION_FAILED');adopted++;},revoke:async(_origin,s)=>{if(revokeFail)throw Error('OFFLINE');revoked.push(s.cookie);}});
 return {control,resolve,revoked,requests,guard:()=>{if(!live)throw Error('KEY_RETIRED');},retire:()=>{live=false;},setConfig:(v:unknown)=>config=v,setExchange:(v:()=>Promise<Response>)=>exchange=v,failPersistence:(value:boolean)=>{persistFail=value;},failRevocation:(value:boolean)=>{revokeFail=value;},failAdoption:()=>{adoptFail=true;},get cancelled(){return cancelled;},get adopted(){return adopted;}};
}
const input={origin,deviceName:'Invented Mac',syncConsent:true};
const finish={code:'secret-code',codeVerifier:'secret-verifier',redirectUri:'http://127.0.0.1:43168/auth/callback'};
async function completed(f:ReturnType<typeof fixture>){for(let i=0;i<50&&f.control.status().state==='waiting';i++)await new Promise(r=>setTimeout(r,2));}
test('explicit consent and exact named backend config are required before native login',async()=>{
 const f=fixture();await assert.rejects(f.control.begin({...input,syncConsent:false},f.guard),/WORKOS_SYNC_CONSENT_REQUIRED/);assert.equal(f.requests.length,0);
 f.setConfig({configured:true,clientId:'client_invented',backendOrigin:'https://other.example'});
 await assert.rejects(f.control.begin(input,f.guard),/WORKOS_BACKEND_CONFIG_INVALID/);assert.equal(f.adopted,0);
});
test('native credentials are adopted only in the trusted controller and absent from status',async()=>{
 const f=fixture(),begin=await f.control.begin(input,f.guard);assert.match(begin.authorizationUrl,/^https:\/\/api.workos.com\//);assert.equal(f.control.status().state,'waiting');
 f.resolve(finish);await completed(f);assert.equal(f.adopted,1);assert.equal(f.control.status().state,'connected');
 const status=JSON.stringify(f.control.status());for(const secret of ['secret','spindle_session',credentials.tracking.csrf,credentials.timer.csrf])assert.ok(!status.includes(secret));assert.equal(f.control.status().accountName,account.name);
});
test('cancelled exchange cannot adopt late credentials and revokes both issued sessions',async()=>{
 const f=fixture();let release!:(r:Response)=>void,arrived!:()=>void;const arrival=new Promise<void>(r=>arrived=r);
 f.setExchange(()=>{arrived();return new Promise(r=>release=r);});await f.control.begin(input,f.guard);f.resolve(finish);await arrival;let settled=false;const cancelled=f.control.cancel().then(()=>{settled=true;});await new Promise(r=>setTimeout(r,5));assert.equal(settled,false);release(Response.json(credentials));await cancelled;
 for(let i=0;i<50&&f.revoked.length<2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.adopted,0);assert.equal(f.revoked.length,2);assert.notEqual(f.control.status().state,'connected');
});
test('retired key prevents adoption and safe errors never reflect backend bodies',async()=>{
 const f=fixture();await f.control.begin(input,f.guard);f.retire();f.resolve(finish);await completed(f);assert.equal(f.adopted,0);assert.notEqual(f.control.status().state,'connected');
 const g=fixture();g.setExchange(async()=>new Response('secret-provider-body',{status:500}));await g.control.begin(input,g.guard);g.resolve(finish);await completed(g);assert.equal(g.control.status().code,'WORKOS_SIGNIN_UNAVAILABLE');assert.ok(!JSON.stringify(g.control.status()).includes('secret'));
});
test('mismatched session accounts reject and revoke both independently issued credentials',async()=>{
 const f=fixture();f.setExchange(async()=>Response.json({...credentials,timer:{...credentials.timer,account:{...account,id:'22345678-1234-1234-1234-123456789abc'}}}));await f.control.begin(input,f.guard);f.resolve(finish);await completed(f);assert.equal(f.adopted,0);assert.equal(f.revoked.length,2);assert.equal(f.control.status().state,'failed');
});
test('account or key retirement clears a previously connected status',async()=>{
 const f=fixture();await f.control.begin(input,f.guard);f.resolve(finish);await completed(f);assert.equal(f.control.status().state,'connected');
 await f.control.retire();assert.deepEqual(f.control.status(),{state:'idle'});
});

test('close waits for issued credential cleanup and rejects future attempts',async()=>{
 const f=fixture();let release!:(r:Response)=>void,arrived!:()=>void;const arrival=new Promise<void>(r=>arrived=r);
 f.setExchange(()=>{arrived();return new Promise(r=>release=r);});await f.control.begin(input,f.guard);f.resolve(finish);await arrival;
 let settled=false;const closed=f.control.close().then(()=>{settled=true;});await new Promise(r=>setTimeout(r,5));assert.equal(settled,false);release(Response.json(credentials));await closed;
 assert.equal(f.adopted,0);assert.equal(f.revoked.length,2);await assert.rejects(f.control.begin(input,f.guard),/WORKOS_HOST_CLOSING/);
});

test('failed rollback retains both credentials and cancellation retries cleanup',async()=>{
 const f=fixture();f.failAdoption();f.failRevocation(true);await f.control.begin(input,f.guard);f.resolve(finish);await completed(f);
 assert.equal(f.control.status().code,'WORKOS_REVOCATION_PENDING');assert.equal(f.revoked.length,0);await assert.rejects(f.control.retire(),/WORKOS_REVOCATION_PENDING/);assert.equal(f.control.status().code,'WORKOS_REVOCATION_PENDING');f.failRevocation(false);await f.control.cancel();assert.equal(f.revoked.length,2);
});

test('uncertain journal persistence never adopts or claims rollback durable',async()=>{
 const f=fixture();f.failPersistence(true);f.failRevocation(true);await f.control.begin(input,f.guard);f.resolve(finish);await completed(f);
 assert.equal(f.adopted,0);assert.equal(f.control.status().code,'WORKOS_DURABILITY_PENDING');await assert.rejects(f.control.cancel(),/WORKOS_DURABILITY_PENDING/);
 f.failPersistence(false);await assert.rejects(f.control.cancel(),/WORKOS_REVOCATION_PENDING/);assert.equal(f.control.status().code,'WORKOS_REVOCATION_PENDING','disk retry must establish durability even while logout remains offline');f.failRevocation(false);await f.control.cancel();assert.equal(f.revoked.length,2);
});
