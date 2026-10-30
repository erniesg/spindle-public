import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {EvidenceStore} from '../../core/evidence/store.js';

test('one authenticated backend retains tracking/device, timer, Google and preparation contracts without model or Google effects',async()=>{
 const root=mkdtempSync(join(tmpdir(),'composed-backend-')),tasks=new AgentStore(join(root,'tasks.sqlite')),evidence=new EvidenceStore(join(root,'evidence'));let factoryCalls=0,googleCalls=0;
 const server=await startTrackingServer(join(root,'account'),randomBytes(32),0,undefined,{clientId:'invented-client',clientSecret:'invented-secret',http:async()=>{googleCalls++;throw Error('No Google request belongs to this test');}},{tasks,store:evidence,workspaceId:'account-private',buildIdentity:'invented-composed-fixture',provider:()=>{factoryCalls++;throw Error('No model belongs to a status read');},tools:()=>{factoryCalls++;return [];}});
 try{
  const client=new AccountClient(server.origin),owner=await client.signin('invented-composed-owner','invented-password-123',true);
  assert.equal((await client.request('/session')as any).deviceId,null);
  assert.equal((await client.request('/pomodoro/session',{})as any).account.id,owner.id);
  assert.equal((await client.request('/pomodoro')as any).accountId,owner.id);
  assert.deepEqual((await client.googleConnections()).connections,[]);
  assert.equal((await client.preparationConfiguration()).configured,true);
  const device=await client.request('/devices',{name:'Invented VM device'})as any;
  assert.equal((await client.request('/session')as any).deviceId,device.deviceId);
  assert.equal((await client.request('/devices')as any).devices[0].id,device.deviceId);
  assert.deepEqual((await client.request('/history?cursor=0&limit=16')as any).entries,[]);
  assert.equal((await fetch(server.origin+'/session',{headers:{Origin:'https://foreign.example.test'}})).status,403);
  assert.equal((await fetch(server.origin+'/session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(server.origin+'/pomodoro/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal(factoryCalls,0);assert.equal(googleCalls,0);
  await client.signout(new AbortController().signal);assert.equal(client.account,undefined);
 }finally{await server.close();evidence.close();tasks.close();rmSync(root,{recursive:true,force:true});}
});
