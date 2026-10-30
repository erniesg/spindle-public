import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {PreparationBinding} from '../../core/preparation/service.js';
import {statefulFixture} from './stateful-fixture.js';

async function bound(){
 const f=await statefulFixture('hold');let capture!:(b:PreparationBinding)=>void;
 const binding=new Promise<PreparationBinding>(resolve=>{capture=resolve;}),factory=f.config.provider;
 f.config.provider=c=>{capture(c.binding);return factory(c);};
 try{await f.client.prepareApplication(f.input());return {f,b:await binding};}catch(e){await f.close();throw e;}
}

test('protected dispatch boxes a pending response and releases the auth FIFO for timer/account writes',async()=>{
 const {f,b}=await bound(),controller=new AbortController();let started=false;
 const server=createServer((_req,_res)=>{/* Deliberately no response headers until cleanup. */});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const box=await b.guardedDispatch(()=>true,()=>{started=true;const request=fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`,{signal:controller.signal});void request.catch(()=>{});return request;});
  assert.equal(started,true);assert.ok(box.started instanceof Promise);
  // This performs real auth-store work while the transport response is pending.
  const timer=await f.client.request('/pomodoro/read',{}) as any;assert.equal(timer.accountId,f.client.account!.id);
  await f.client.selectGoogleRoots(f.connectionId,['root']);
  controller.abort();await assert.rejects(box.started);
 }finally{controller.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('final dispatch denies a retired root or session even after an earlier successful source preflight',async()=>{
 for(const revoke of ['root','session'] as const){
  const {f,b}=await bound();let packets=0;
  try{
   await b.assertCurrent();
   if(revoke==='root')await f.client.selectGoogleRoots(f.connectionId,[]);else await f.client.signout();
   await assert.rejects(b.guardedDispatch(()=>true,()=>{packets++;}),/GOOGLE_ROOT_CHANGED|GOOGLE_AUTH_CONTEXT_CHANGED/);
   assert.equal(packets,0);
  }finally{await f.close();}
 }
});

test('synchronous task guard and abort are checked after protected auth, before packet invocation',async()=>{
 const {f,b}=await bound();let packets=0;try{
  await assert.rejects(b.guardedDispatch(()=>false,()=>{packets++;}),/GOOGLE_DISPATCH_NOT_CURRENT/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(b.guardedDispatch(()=>true,()=>{packets++;},{signal:controller.signal}));
  assert.equal(packets,0);
 }finally{await f.close();}
});
