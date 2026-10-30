/** Timer domain only: never selects an account, enrolls a collector or measures captured activity. */
export interface Durations {focusMs:number;breakMs:number}
export type Phase='focus'|'break';
export type TimerStatus='idle'|'running'|'paused'|'completed';
export interface Timer {
 revision:number; sessionId:string|null; phase:Phase; status:TimerStatus;
 durations:Durations; remainingMs:number; deadlineAt:number|null; updatedAt:number;
}
export type Action='start'|'pause'|'resume'|'reset'|'end'|'next';
export interface Command {id:string;expectedRevision:number;action:Action;durations?:Durations}
export interface Snapshot {timer:Timer;serverNow:number}
export interface Acknowledgement extends Snapshot {appliedRevision:number}
export const DEFAULT_DURATIONS:Readonly<Durations>={focusMs:25*60000,breakMs:5*60000};
export const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validDurations(v:unknown):v is Durations {
 return object(v)&&Object.keys(v).sort().join(',')==='breakMs,focusMs'&&[v.focusMs,v.breakMs].every(n=>Number.isSafeInteger(n)&&(n as number)>=1000&&(n as number)<=180*60000);
}
export function validCommand(v:unknown):v is Command {
 return object(v)&&Object.keys(v).every(k=>['id','expectedRevision','action','durations'].includes(k))&&typeof v.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v.id)&&Number.isSafeInteger(v.expectedRevision)&&(v.expectedRevision as number)>=0&&['start','pause','resume','reset','end','next'].includes(v.action as string)&&(v.durations===undefined||v.action==='start'&&validDurations(v.durations));
}
export function validSnapshot(v:unknown):v is Snapshot {
 if(!object(v)||!Number.isSafeInteger(v.serverNow)||!object(v.timer))return false;
 const t=v.timer;
 return Number.isSafeInteger(t.revision)&&(t.revision as number)>=0&&(t.sessionId===null||typeof t.sessionId==='string'&&/^[a-f0-9-]{36}$/.test(t.sessionId))&&['focus','break'].includes(t.phase as string)&&['idle','running','paused','completed'].includes(t.status as string)&&validDurations(t.durations)&&Number.isSafeInteger(t.remainingMs)&&(t.remainingMs as number)>=0&&(t.remainingMs as number)<=180*60000&&Number.isSafeInteger(t.updatedAt)&&(t.status==='running'?Number.isSafeInteger(t.deadlineAt)&&t.sessionId!==null:t.deadlineAt===null);
}
