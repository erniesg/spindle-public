import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PomodoroClient,type AuthenticatedSnapshot,type TimerTransport} from '../../core/pomodoro/client.js';
import {newPomodoro,commandPomodoro,readPomodoro} from '../../core/pomodoro/service.js';

test('countdown uses canonical timestamps; offline/suspension disables controls without replay',async()=>{
 let now=1000,mono=1000,offline=false,calls=0;const state=newPomodoro();
 const transport:TimerTransport={session:async()=>({id:'alice',name:'invented-alice'}),read:async()=>{if(offline)throw Error('OFFLINE');return {...readPomodoro(state,now),accountId:'alice'};},command:async op=>{calls++;return {...commandPomodoro(state,op,now),accountId:'alice'};},signout:async()=>{}};
 const client=new PomodoroClient(transport,()=>{},()=>now,()=>mono);
 await client.connect();await client.act('start',{focusMs:60000,breakMs:30000});
 now+=20000;mono+=20000;assert.equal(client.remaining(),40000);assert.equal(client.fresh,false);
 await client.act('pause');assert.equal(calls,1);
 offline=true;await client.refresh();assert.equal(client.connection,'stale');await client.act('pause');assert.equal(calls,1);
 offline=false;await client.refresh();assert.equal(client.fresh,true);assert.equal(calls,1);
 await client.act('pause');assert.equal(calls,2);assert.equal(client.remaining(),40000);
 now+=50000; // Wall/monotonic divergence (sleep or clock edit) is stale, never silent drift.
 assert.equal(client.fresh,false);await client.act('resume');assert.equal(calls,2);
});

test('account switch never renders another account timer; in-flight reads cannot undo signout',async()=>{
 let resolve!:(snapshot:AuthenticatedSnapshot)=>void,delay=false,accountId='alice';const state=newPomodoro();
 const transport:TimerTransport={session:async()=>({id:'alice',name:'invented-alice'}),read:async()=>delay?new Promise(r=>{resolve=r;}):({...readPomodoro(state,1000),accountId}),command:async()=>{throw Error();},signout:async()=>{}};
 const client=new PomodoroClient(transport);
 await client.connect();assert.equal(client.account?.id,'alice');
 accountId='bob';await client.refresh();assert.equal(client.account,undefined);assert.equal(client.snapshot,undefined);
 accountId='alice';await client.connect();delay=true;
 const pending=client.refresh();await client.signout();resolve({...readPomodoro(state,1000),accountId:'alice'});await pending;
 assert.equal(client.account,undefined);assert.equal(client.snapshot,undefined);assert.equal(client.connection,'signed-out');
});

test('lost response marks stale; reconciling reads current state without replaying effect',async()=>{
 const state=newPomodoro();let calls=0;
 const transport:TimerTransport={session:async()=>({id:'alice',name:'invented-alice'}),read:async()=>({...readPomodoro(state,1000),accountId:'alice'}),command:async op=>{calls++;commandPomodoro(state,op,1000);throw Error('LOST_RESPONSE');},signout:async()=>{}};
 const client=new PomodoroClient(transport);
 await client.connect();await client.act('start');assert.equal(client.connection,'stale');assert.equal(calls,1);
 await client.refresh();assert.equal(client.snapshot?.timer.revision,1);assert.equal(client.snapshot?.timer.status,'running');assert.equal(calls,1);
});

test('a refresh announces pending synchronously so visible controls cannot silently drop an owner click',async()=>{
 const state=newPomodoro();let held=false,release!:(snapshot:AuthenticatedSnapshot)=>void;const pendingStates:boolean[]=[];
 const transport:TimerTransport={session:async()=>({id:'alice',name:'invented-alice'}),read:async()=>held?new Promise(r=>{release=r;}):({...readPomodoro(state,1000),accountId:'alice'}),command:async()=>{throw Error('No command expected');},signout:async()=>{}};
 const client=new PomodoroClient(transport,()=>pendingStates.push(client.pending));await client.connect();held=true;
 const pending=client.refresh();try{assert.equal(client.pending,true);assert.equal(pendingStates.at(-1),true,'the pending read must disable controls before another event can click them');}
 finally{release({...readPomodoro(state,1000),accountId:'alice'});await pending;}
 assert.equal(pendingStates.at(-1),false);
});
