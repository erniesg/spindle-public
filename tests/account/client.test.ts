import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountClient} from '../../core/account/client.js';
const id='12345678-1234-4123-8123-123456789abc',csrf='a'.repeat(64),cookie='spindle_session='+'b'.repeat(64);
const auth=()=>new Response(JSON.stringify({csrf}),{headers:{'set-cookie':cookie}});
const session=(extra:Record<string,unknown>={})=>new Response(JSON.stringify({account:{id,name:'invented'},csrf,...extra}));
test('account client rejects insecure endpoints and invalid sessions',async()=>{
 for(const origin of ['http://example.test','https://example.test/','https://user:pass@example.test'])assert.throws(()=>new AccountClient(origin));
 for(const bad of [{csrf:'c'.repeat(64)},{csrf:undefined},{account:{id:'not-a-uuid',name:'invented'}},{account:{id,name:'other'}}]){
  let calls=0;const client=new AccountClient('https://example.test',async()=>calls++===0?auth():session(bad));
  await assert.rejects(client.signin('invented','invented-password'));assert.equal(client.account,undefined);
 }
});
test('bounded responses, redirect policy, signout generation and request paths',async()=>{
 let calls=0;let release:((response:Response)=>void)|undefined;
 const client=new AccountClient('https://example.test',async(_url,init)=>{
  assert.equal(init?.redirect,'error');calls++;
  if(calls===1)return auth();if(calls===2)return session();
  if(calls===3)return new Response('x'.repeat(1100001));
  if(calls===4)return new Promise<Response>(resolve=>{release=resolve;});
  return new Response('{}');
 });
 await client.signin('invented','invented-password');
 await assert.rejects(client.request('//other.invalid'),/INVALID_ACCOUNT_PATH/);
 await assert.rejects(client.request('/oversized'),/RESPONSE_BOUND/);
 const pending=client.request('/pending');await client.signout();release!(new Response('{}'));await assert.rejects(pending,/ACCOUNT_CHANGED/);
 let resolveSession:((response:Response)=>void)|undefined;calls=0;
 const signing=new AccountClient('https://example.test',async()=>++calls===1?auth():calls===2?new Promise<Response>(resolve=>{resolveSession=resolve;}):new Response('{}'));
 const signin=signing.signin('invented','invented-password');
 while(!resolveSession)await new Promise(resolve=>setImmediate(resolve));
 const rejected=assert.rejects(signin,/ACCOUNT_IDENTITY_MISMATCH/),logout=signing.signout();resolveSession(session());await logout;await rejected;assert.equal(signing.account,undefined);
});
