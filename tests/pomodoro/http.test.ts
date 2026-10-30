import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {AccountClient} from '../../core/account/client.js';
import type {Acknowledgement,Snapshot} from '../../core/pomodoro/protocol.js';

test('real authenticated account transactions: independent clients, CAS, lost response, account isolation and durable restart',async()=>{
 await mkdir('.local',{recursive:true});
 const directory=await mkdtemp(join(process.cwd(),'.local/pomodoro-http-')),key=randomBytes(32);
 let server=await startTrackingServer(directory,key);
 try{
  const alice=new AccountClient(server.origin),otherClient=new AccountClient(server.origin),bob=new AccountClient(server.origin);
  const identity=await alice.signin('invented-alice','invented-only-password',true);
  assert.deepEqual(await otherClient.signin('invented-alice','invented-only-password'),identity);
  await bob.signin('invented-bob','invented-only-password',true);
  const op={id:'start-http',expectedRevision:0,action:'start',durations:{focusMs:60000,breakMs:30000}};
  const started=await alice.request('/pomodoro/command',op) as Acknowledgement;
  assert.equal(started.timer.status,'running');assert.equal(started.timer.revision,1);
  assert.deepEqual((await otherClient.request('/pomodoro') as Snapshot).timer,started.timer);
  const outcomes=await Promise.allSettled([
   alice.request('/pomodoro/command',{id:'pause-race',expectedRevision:1,action:'pause'}),
   otherClient.request('/pomodoro/command',{id:'end-race',expectedRevision:1,action:'end'}),
  ]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const current=await otherClient.request('/pomodoro') as Snapshot;
  assert.equal(current.timer.revision,2);
  // Simulate losing an acknowledged response, then retry against durable receipts.
  const reset={id:'lost-reset',expectedRevision:2,action:'reset'};
  await alice.request('/pomodoro/command',reset);
  const replay=await otherClient.request('/pomodoro/command',reset) as Acknowledgement;
  assert.equal(replay.timer.revision,3);assert.equal(replay.appliedRevision,3);
  assert.equal((await otherClient.request('/pomodoro/command',op) as Acknowledgement).timer.status,'idle');
  await assert.rejects(otherClient.request('/pomodoro/command',{id:'late-write',expectedRevision:1,action:'resume'}),/409/);
  assert.equal((await bob.request('/pomodoro') as Snapshot).timer.revision,0);
  await assert.rejects(bob.request('/pomodoro/command',{id:'spoof',expectedRevision:0,action:'reset',accountId:identity.id}),/400/);
  for(const headers of [{Origin:server.origin},{Origin:'https://untrusted.example'},{}] as Record<string,string>[]){
   const response=await fetch(server.origin+'/pomodoro',{headers});assert.ok([401,403].includes(response.status));await response.body?.cancel();
  }
  assert.deepEqual(await alice.request('/devices'),{devices:[]}); // Device-free viewer read proves timer signin never enrolled a collector.
  const encrypted=await readFile(join(directory,'tracking.enc'));
  assert.equal(encrypted.includes(Buffer.from('invented-alice')),false);
  const port=Number(new URL(server.origin).port);
  await server.close();server=await startTrackingServer(directory,key,port);
  assert.equal((await otherClient.request('/pomodoro') as Snapshot).timer.revision,3);
  assert.equal((await otherClient.request('/pomodoro/command',reset) as Acknowledgement).appliedRevision,3);
  await alice.signout();await assert.rejects(alice.request('/pomodoro'),/SIGNIN_REQUIRED/);
  assert.equal((await otherClient.request('/pomodoro') as Snapshot).timer.revision,3);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
