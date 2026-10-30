import {createHash,randomUUID} from 'node:crypto';
import {DEFAULT_DURATIONS,validCommand,type Timer,type Snapshot,type Acknowledgement} from './protocol.js';
export interface PomodoroState {timer:Timer;receipts:{id:string;digest:string;revision:number}[]}
export class PomodoroFailure extends Error {constructor(readonly status:number,code:string){super(code);}}
function fail(status:number,code:string):never {throw new PomodoroFailure(status,code);}
export function newPomodoro():PomodoroState {
 return {timer:{revision:0,sessionId:null,phase:'focus',status:'idle',durations:{...DEFAULT_DURATIONS},remainingMs:DEFAULT_DURATIONS.focusMs,deadlineAt:null,updatedAt:0},receipts:[]};
}
function increment(timer:Timer,now:number){if(timer.revision>=Number.MAX_SAFE_INTEGER)fail(507,'POMODORO_REVISION_BOUND');timer.revision++;timer.updatedAt=now;}
/** Caller persists this in the SAME encrypted transaction as the authenticated account. */
export function readPomodoro(state:PomodoroState,now=Date.now()):Snapshot {
 const t=state.timer;
 if(t.status==='running'&&t.deadlineAt!<=now){increment(t,t.deadlineAt!);t.status='completed';t.remainingMs=0;t.deadlineAt=null;}
 return {timer:structuredClone(t),serverNow:now};
}
export function commandPomodoro(state:PomodoroState,value:unknown,now=Date.now()):Acknowledgement {
 if(!validCommand(value))fail(400,'INVALID_POMODORO_COMMAND');
 const op=value;
 // Stable, exact semantic encoding independent of JSON object key order.
 const digest=createHash('sha256').update(JSON.stringify([op.expectedRevision,op.action,op.durations?.focusMs??null,op.durations?.breakMs??null])).digest('hex');
 const receipt=state.receipts.find(r=>r.id===op.id);
 if(receipt){if(receipt.digest!==digest)fail(409,'POMODORO_OPERATION_CONFLICT');return {...readPomodoro(state,now),appliedRevision:receipt.revision};}
 const snapshot=readPomodoro(state,now),t=state.timer;
 if(op.expectedRevision!==t.revision)fail(409,'POMODORO_STALE_REVISION');
 // Validate before touching state: failed commands must not leave partial writes.
 if(op.action==='start'&&t.status!=='idle'||op.action==='pause'&&t.status!=='running'||op.action==='resume'&&t.status!=='paused'||op.action==='end'&&!['running','paused'].includes(t.status)||op.action==='next'&&t.status!=='completed')fail(409,'POMODORO_INVALID_TRANSITION');
 increment(t,now);
 switch(op.action){
  case 'start':
   if(op.durations)t.durations={...op.durations};
   t.phase='focus';t.sessionId=randomUUID();t.status='running';t.remainingMs=t.durations.focusMs;t.deadlineAt=now+t.remainingMs;break;
  case 'pause':t.remainingMs=Math.max(0,t.deadlineAt!-now);t.deadlineAt=null;t.status='paused';break;
  case 'resume':t.deadlineAt=now+t.remainingMs;t.status='running';break;
  case 'reset':t.sessionId=null;t.phase='focus';t.status='idle';t.remainingMs=t.durations.focusMs;t.deadlineAt=null;break;
  case 'end':t.status='completed';t.remainingMs=0;t.deadlineAt=null;break;
  case 'next':t.phase=t.phase==='focus'?'break':'focus';t.sessionId=randomUUID();t.status='running';t.remainingMs=t.phase==='focus'?t.durations.focusMs:t.durations.breakMs;t.deadlineAt=now+t.remainingMs;break;
 }
 // Older IDs may be retired safely: every mutation consumes a globally increasing
 // revision, so an evicted retry is stale forever, even after reset/server restart.
 state.receipts.push({id:op.id,digest,revision:t.revision});if(state.receipts.length>256)state.receipts.shift();
 return {timer:structuredClone(t),serverNow:snapshot.serverNow,appliedRevision:t.revision};
}
