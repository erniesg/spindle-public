import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {DesktopPomodoro} from '../../core/pomodoro/desktop.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';

test('device-free desktop adapter authenticates real accounts and only exposes narrow timer operations to extension',async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/pomodoro-desktop-'));
 const server=await startTrackingServer(directory,randomBytes(32));const desktop=new DesktopPomodoro();
 try{
  await assert.rejects(desktop.extension({action:'read'}),/SIGNIN_REQUIRED/);
  const alice=await desktop.signin({origin:server.origin,name:'invented-desktop-alice',password:'invented-only-password',register:true});
  assert.deepEqual(await desktop.extension({action:'session'}),alice);
  await desktop.extension({action:'command',binding:alice.binding,command:{id:'desktop-start',expectedRevision:0,action:'start'}});
  const snapshot=await desktop.read(alice.binding);assert.equal(snapshot.accountId,alice.id);assert.equal(snapshot.timer.status,'running');
  for(const value of [{action:'signin',name:'spoof'},{action:'read',accountId:'other'},{action:'command',command:{id:'spoof',expectedRevision:1,action:'reset',accountId:'other'}},{action:'read',path:'/history'}])await assert.rejects(desktop.extension({...value,binding:alice.binding}),/INVALID_POMODORO/);
  const old=await desktop.session();
  const bob=await desktop.signin({origin:server.origin,name:'invented-desktop-bob',password:'invented-only-password',register:true});
  assert.notEqual(bob.id,alice.id);assert.equal((await desktop.read(bob.binding)).timer.revision,0);
  await desktop.command({id:'bob-start',expectedRevision:0,action:'start'},bob.binding);
  await assert.rejects(desktop.extension({action:'command',command:{id:'unbound-alice-pause',expectedRevision:1,action:'pause'}}),/ACCOUNT_CHANGED/);
  await assert.rejects(desktop.extension({action:'command',binding:old.binding,command:{id:'stale-alice-pause',expectedRevision:1,action:'pause'}}),/ACCOUNT_CHANGED/);
  await assert.rejects(desktop.extension({action:'signout',binding:old.binding}),/ACCOUNT_CHANGED/);
  await assert.rejects(desktop.read(old.binding),/ACCOUNT_CHANGED/);
  assert.equal((await desktop.read(bob.binding)).timer.status,'running');
  await desktop.extension({action:'signout',binding:bob.binding});await assert.rejects(desktop.read(bob.binding),/SIGNIN_REQUIRED/);
  const again=await desktop.signin({origin:server.origin,name:'invented-desktop-alice',password:'invented-only-password'});
  assert.notEqual(again.binding,old.binding);
  await assert.rejects(desktop.command({id:'old-binding',expectedRevision:1,action:'pause'},old.binding),/ACCOUNT_CHANGED/);
  assert.equal((await desktop.extension({action:'read',binding:again.binding}) as Snapshot).timer.revision,1);
 }finally{await desktop.close();await server.close();await rm(directory,{recursive:true,force:true});}
});
