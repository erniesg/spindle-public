import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newPomodoro, readPomodoro, commandPomodoro} from '../../core/pomodoro/service.js';

test('canonical deadlines survive suspension; pause/resume and explicit break preserve one session',()=>{
 const state=newPomodoro();
 const started=commandPomodoro(state,{id:'start-1',expectedRevision:0,action:'start',durations:{focusMs:60000,breakMs:30000}},1000);
 assert.equal(started.timer.deadlineAt,61000);assert.equal(started.timer.revision,1);
 const paused=commandPomodoro(state,{id:'pause-1',expectedRevision:1,action:'pause'},11000);
 assert.equal(paused.timer.remainingMs,50000);assert.equal(paused.timer.deadlineAt,null);
 assert.equal(readPomodoro(state,900000).timer.remainingMs,50000);
 const resumed=commandPomodoro(state,{id:'resume-1',expectedRevision:2,action:'resume'},900000);
 assert.equal(resumed.timer.deadlineAt,950000);assert.equal(resumed.timer.sessionId,started.timer.sessionId);
 const expired=readPomodoro(state,1000000);
 assert.equal(expired.timer.status,'completed');assert.equal(expired.timer.remainingMs,0);assert.equal(expired.timer.updatedAt,950000);
 assert.equal(readPomodoro(state,1001000).timer.revision,expired.timer.revision);
 const next=commandPomodoro(state,{id:'break-1',expectedRevision:expired.timer.revision,action:'next'},1001000);
 assert.equal(next.timer.phase,'break');assert.equal(next.timer.deadlineAt,1031000);assert.notEqual(next.timer.sessionId,started.timer.sessionId);
});

test('CAS, reset and idempotency fence concurrency, late writes and lost responses',()=>{
 const state=newPomodoro();
 const op={id:'lost-response',expectedRevision:0,action:'start'};
 const first=commandPomodoro(state,op,1000);
 const replay=commandPomodoro(state,op,2000);
 assert.equal(replay.timer.revision,1);assert.equal(replay.appliedRevision,1);assert.equal(replay.timer.deadlineAt,first.timer.deadlineAt);
 assert.throws(()=>commandPomodoro(state,{...op,action:'end'},2000),/OPERATION_CONFLICT/);
 commandPomodoro(state,{id:'reset',expectedRevision:1,action:'reset'},3000);
 const late=commandPomodoro(state,op,4000);
 assert.equal(late.timer.status,'idle');assert.equal(late.timer.revision,2);assert.equal(late.appliedRevision,1);
 assert.throws(()=>commandPomodoro(state,{id:'late-resume',expectedRevision:1,action:'resume'},5000),/STALE_REVISION/);
 assert.equal(readPomodoro(state,5000).timer.status,'idle');
});

test('durable state/receipts survive serialization; evicted retries cannot apply again',()=>{
 let state=newPomodoro();const op={id:'old-start',expectedRevision:0,action:'start'};
 commandPomodoro(state,op,1000);
 state=JSON.parse(JSON.stringify(state));
 assert.equal(commandPomodoro(state,op,1100).timer.revision,1);
 for(let i=1;i<=300;i++)commandPomodoro(state,{id:`reset-${i}`,expectedRevision:i,action:'reset'},2000+i);
 assert.ok(state.receipts.length<=256);
 assert.throws(()=>commandPomodoro(state,op,4000),/STALE_REVISION/);
 assert.equal(state.timer.revision,301);
});

test('reject injected authority, malformed commands, impossible transitions and invalid durations without mutations',()=>{
 const state=newPomodoro();const before=JSON.stringify(state);
 for(const value of [null,{}, {id:'bad',expectedRevision:0,action:'start',accountId:'someone-else'}, {id:'bad',expectedRevision:-1,action:'reset'}, {id:'bad',expectedRevision:0,action:'start',durations:{focusMs:0,breakMs:300000}}, {id:'bad',expectedRevision:0,action:'pause'}, {id:'bad',expectedRevision:0,action:'resume'}, {id:'bad',expectedRevision:0,action:'next'}])assert.throws(()=>commandPomodoro(state,value,1000));
 assert.equal(JSON.stringify(state),before);
});
