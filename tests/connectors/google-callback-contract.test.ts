import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleOAuth,GoogleOAuthFailure,scopes,type CredentialStore,type GoogleCallbackReason} from '../../core/connectors/google/oauth.js';

function fixture(){
 let calls=0,reads=0,credential:string|undefined;
 const store:CredentialStore={get:async()=>{reads++;return credential;},set:async()=>{throw Error('CAS only');},delete:async()=>{throw Error('CAS only');},compareAndSet:async(_id,expected,value)=>{assert.equal(credential,expected);credential=value;return true;}};
 const oauth=new GoogleOAuth('invented-client',store,async()=>{calls++;return calls===1?Response.json({access_token:'PRIVATE_ACCESS_SENTINEL',refresh_token:'PRIVATE_REFRESH_SENTINEL',scope:[scopes.mail,scopes.drive].join(' ')}):Response.json({emailAddress:'verified@example.test'});});
 const flow=oauth.begin(12345,[scopes.mail,scopes.drive]),url=new URL(flow.redirect);url.search=new URLSearchParams({state:flow.state,code:'PRIVATE_CODE_SENTINEL',iss:'https://accounts.google.com',hd:'untrusted.example',scope:scopes.mail,authuser:'0',prompt:'consent'}).toString();
 return {oauth,flow,url,calls:()=>calls,reads:()=>reads,credential:()=>credential};
}
for(const issuer of ['present','absent'] as const)test(`Google callback accepts ${issuer} issuer with bounded ignored extensions; profile alone owns identity`,async()=>{
 const f=fixture();if(issuer==='absent')f.url.searchParams.delete('iss');
 const result=await f.oauth.exchange(f.url.href,f.flow,'invented-row');assert.equal(result.accountId,'verified@example.test');assert.equal(f.calls(),2);assert.equal(JSON.parse(f.credential()!).accountId,'verified@example.test');assert.ok(!f.credential()!.includes('untrusted.example'));assert.deepEqual(result.missingGrants,[]);
 await assert.rejects(f.oauth.exchange(f.url.href,f.flow,'invented-row'),(e:any)=>e.code==='GOOGLE_FLOW_EXPIRED_OR_USED');assert.equal(f.calls(),2);
});
const cases:[string,GoogleCallbackReason,(url:URL)=>string|void][]=[
 ['wrong origin','origin_mismatch',u=>{u.port='12346';}],
 ['wrong path','path_mismatch',u=>{u.pathname='/other';}],
 ['raw dot segment','path_mismatch',u=>u.href.replace('/oauth/callback','/other/../oauth/callback')],
 ['short state','state_length',u=>{u.searchParams.set('state','x');}],
 ['wrong equal-length state','state_mismatch',u=>{const state=u.searchParams.get('state')!;u.searchParams.set('state',(state[0]==='a'?'b':'a')+state.slice(1));}],
 ['duplicate state','duplicate_parameter',u=>{u.searchParams.append('state',u.searchParams.get('state')!);}],
 ['duplicate issuer','duplicate_parameter',u=>{u.searchParams.append('iss','https://accounts.google.com');}],
 ['duplicate extension','duplicate_parameter',u=>{u.searchParams.append('hd','other.example');}],
 ['unknown field','unsupported_parameter',u=>{u.searchParams.set('PRIVATE_ATTACKER_NAME','PRIVATE_ATTACKER_VALUE');}],
 ['missing code','missing_code',u=>{u.searchParams.delete('code');}],
 ['empty code','missing_code',u=>{u.searchParams.set('code','');}],
 ['invalid code','invalid_code',u=>{u.searchParams.set('code','PRIVATE CODE');}],
 ['wrong issuer','issuer_mismatch',u=>{u.searchParams.set('iss','https://attacker.invalid');}],
 ['issuer trailing slash','issuer_mismatch',u=>{u.searchParams.set('iss','https://accounts.google.com/');}],
 ['empty issuer','issuer_mismatch',u=>{u.searchParams.set('iss','');}],
 ['fragment','fragment_present',u=>{u.hash='PRIVATE_FRAGMENT';}],
 ['oversize hd','invalid_extension',u=>{u.searchParams.set('hd','x'.repeat(254));}],
 ['control hd','invalid_extension',u=>{u.searchParams.set('hd','PRIVATE\nVALUE');}],
 ['malformed URL','malformed_url',()=> 'not a URL PRIVATE_SENTINEL']
];
for(const [name,reason,mutate] of cases)test(`callback rejects ${name} with fixed ${reason} before credentials/provider`,async()=>{
 const f=fixture(),callback=mutate(f.url)??f.url.href;
 await assert.rejects(f.oauth.exchange(callback,f.flow,'invented-row'),(e:unknown)=>{assert.ok(e instanceof GoogleOAuthFailure);assert.equal(e.code,'GOOGLE_CALLBACK_INVALID');assert.equal(e.reason,reason);assert.ok(!JSON.stringify(e).includes('PRIVATE_'));assert.ok(!e.stack?.includes('PRIVATE_'));return true;});
 assert.equal(f.calls(),0);assert.equal(f.reads(),0);assert.equal(f.credential(),undefined);
});
test('issuer validated even on provider denial; valid denial is distinct from missing code',async()=>{
 const f=fixture();f.url.searchParams.delete('code');f.url.searchParams.set('error','access_denied');
 await assert.rejects(f.oauth.exchange(f.url.href,f.flow,'invented-row'),(e:any)=>e.code==='GOOGLE_CONSENT_DENIED'&&e.reason===undefined);assert.equal(f.calls(),0);
 const wrong=fixture();wrong.url.searchParams.set('error','access_denied');wrong.url.searchParams.set('iss','https://wrong.invalid');
 await assert.rejects(wrong.oauth.exchange(wrong.url.href,wrong.flow,'invented-row'),(e:any)=>e.reason==='issuer_mismatch');assert.equal(wrong.calls(),0);
});
