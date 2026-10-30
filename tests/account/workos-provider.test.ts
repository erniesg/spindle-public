import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportJWK, generateKeyPair, SignJWT, type JWTPayload} from 'jose';
import {WorkOSProvider, type WorkOSConfig} from '../../core/account/workos-provider.js';

const config: WorkOSConfig = {
  clientId: 'client_01M5068NP231S1TTFY2FCX8WGN',
  issuer: 'https://api.workos.com/user_management/client_01KXP33HD63BY3BYYC0BDHZMRB',
  jwksUri: 'https://api.workos.com/sso/jwks/client_01KXP33HD63BY3BYYC0BDHZMRB',
  webRedirectUri: 'https://spindle.example/auth/workos/callback',
};
const keys = await generateKeyPair('RS256');
const now = Math.floor(Date.now()/1000);
const verifier = 'v'.repeat(43), challenge = 'c'.repeat(43);
async function token(overrides: JWTPayload = {}, key = keys.privateKey) {
  return new SignJWT({iss: config.issuer, sub: 'user_trusted', sid: 'session_trusted', client_id: config.clientId,
    iat: now, auth_time: now - 10, exp: now + 300, ...overrides})
    .setProtectedHeader({alg:'RS256',kid:'test'}).sign(key);
}
const providerFor = (accessToken: string) => new WorkOSProvider(config, {
  fetch: async () => Response.json({access_token: accessToken, user: {id:'user_untrusted', email:'ignored@example.test'}}),
  keyResolver: async () => keys.publicKey,
});

test('authorization uses fixed WorkOS public PKCE endpoint and preserves state', () => {
  const provider = new WorkOSProvider(config);
  const url = new URL(provider.authorizationUrl(config.webRedirectUri, 'opaque state', challenge));
  assert.equal(url.origin + url.pathname, 'https://api.workos.com/user_management/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {client_id:config.clientId, redirect_uri:config.webRedirectUri,
    response_type:'code', provider:'authkit', state:'opaque state', code_challenge:challenge, code_challenge_method:'S256'});
});

test('configuration rejects endpoints outside exact WorkOS issuer/JWKS paths', () => {
  for (const patch of [
    {clientId:''}, {clientId:'sk_secret'}, {issuer:'http://api.workos.com/user_management/client_abc'},
    {issuer:'https://api.workos.com.evil.test/user_management/client_abc'},
    {issuer:config.issuer+'?x=1'}, {issuer:'https://user@api.workos.com/user_management/client_abc'},
    {jwksUri:'https://evil.test/keys'}, {jwksUri:config.jwksUri+'/extra'},
    {jwksUri:'https://api.workos.com/sso/jwks/client_other'},
    {webRedirectUri:'http://public.example/callback'}, {webRedirectUri:'https://user:pass@spindle.example/callback'},
  ]) assert.throws(() => new WorkOSProvider({...config,...patch}));
});

test('exchange sends only public-client PKCE parameters and returns verified identity', async () => {
  const accessToken = await token();
  const provider = new WorkOSProvider(config, {keyResolver:async()=>keys.publicKey, fetch:async(url, init)=>{
    assert.equal(url, 'https://api.workos.com/user_management/authenticate');
    assert.equal(init?.method,'POST'); assert.equal(init?.redirect,'error'); assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), {grant_type:'authorization_code',client_id:config.clientId,code:'code',code_verifier:verifier});
    return Response.json({access_token:accessToken,user:{id:'user_other',email:'attacker@example.test'}});
  }});
  assert.deepEqual(await provider.exchange('code',verifier), {subject:'user_trusted',sessionId:'session_trusted',clientId:config.clientId,expiresAt:now+300});
});

test('signed sibling-client, malformed user, machine, time and audience claims cannot sign in', async () => {
  for (const claims of [
    {iss:'https://other.test'}, {client_id:'client_sibling'}, {client_id:undefined},
    {exp:now-1}, {exp:undefined}, {nbf:now+300}, {iat:now+300},
    {sub:''}, {sub:'agent_instance_123'}, {sid:''}, {sid:undefined},
    {auth_time:'123'}, {auth_time:now+300}, {iat:undefined}, {iat:now+301,exp:now+300},
    {sub_type:'machine'}, {sub_type:'user'}, {sub_profile:'ai_agent'}, {sub_profile:'unknown'},
    {aud:'client_sibling'}, {aud:[config.clientId,'client_sibling']}, {aud:42},
  ]) {
    await assert.rejects(providerFor(await token(claims as JWTPayload)).exchange('code',verifier), /WORKOS_AUTHENTICATION_FAILED/, JSON.stringify(claims));
  }
  assert.equal((await providerFor(await token({aud:config.clientId, sub_profile:'user',auth_time:undefined})).exchange('code',verifier)).subject,'user_trusted');
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(providerFor(await token({},attacker.privateKey)).exchange('code',verifier),/WORKOS_AUTHENTICATION_FAILED/);
});

test('replayed code rejection and network/provider errors expose no upstream details', async () => {
  let calls=0;
  const accessToken = await token();
  const provider = new WorkOSProvider(config, {keyResolver:async()=>keys.publicKey,fetch:async()=>
    ++calls===1 ? Response.json({access_token:accessToken}) : Response.json({error:'invalid_grant',error_description:'secret upstream'}, {status:400})});
  await provider.exchange('one-time',verifier);
  await assert.rejects(provider.exchange('one-time',verifier),/^Error: WORKOS_AUTHENTICATION_FAILED$/);
  const failing = new WorkOSProvider(config,{fetch:async()=>{throw new Error('private internal network detail');}});
  await assert.rejects(failing.exchange('code',verifier),/^Error: WORKOS_AUTHENTICATION_FAILED$/);
});

test('response parser bounds declared and streamed bodies and rejects invalid JSON/tokens', async () => {
  for (const response of [new Response('x'.repeat(70_000)),new Response('{}',{headers:{'content-length':'70000'}}),
    new Response('{'),Response.json({}),Response.json({access_token:42}),Response.json({access_token:'not-a-jwt'})]) {
    const provider = new WorkOSProvider(config,{fetch:async()=>response,keyResolver:async()=>keys.publicKey});
    await assert.rejects(provider.exchange('code',verifier),/^Error: WORKOS_AUTHENTICATION_FAILED$/);
  }
});

test('bad PKCE/code/redirect input is rejected before any network request', async () => {
  const provider = new WorkOSProvider(config,{fetch:async()=>{assert.fail('must not fetch');}});
  await assert.rejects(provider.exchange('',verifier));
  await assert.rejects(provider.exchange('code','short'));
  assert.throws(()=>provider.authorizationUrl('https://attacker.example/callback','state',challenge));
  assert.throws(()=>provider.authorizationUrl(config.webRedirectUri,'',challenge));
  assert.throws(()=>provider.authorizationUrl(config.webRedirectUri,'state','bad'));
});


test('default remote JWKS resolver uses bounded fixed endpoint without redirects', async () => {
  const accessToken = await token();
  const jwk = await exportJWK(keys.publicKey);
  let jwksRequests = 0;
  const provider = new WorkOSProvider(config, {fetch:async(url,init)=>{
    assert.equal(init?.redirect,'error');
    assert.ok(init?.signal);
    if (String(url) === config.jwksUri) {
      jwksRequests++;
      return Response.json({keys:[{...jwk,kid:'test',alg:'RS256',use:'sig'}]});
    }
    assert.equal(String(url),'https://api.workos.com/user_management/authenticate');
    return Response.json({access_token:accessToken});
  }});
  assert.equal((await provider.exchange('code',verifier)).subject,'user_trusted');
  assert.equal(jwksRequests,1);
  const forged = await new SignJWT({iss:config.issuer,sub:'user_trusted',client_id:config.clientId,
    sid:'session_trusted',iat:now,exp:now+300}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32).fill(1));
  await assert.rejects(providerFor(forged).exchange('code',verifier),/WORKOS_AUTHENTICATION_FAILED/);
});
