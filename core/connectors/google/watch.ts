import { abortRace } from './abort.js';
import { boundedJson } from './bounded.js';
import type { GoogleWakeJournal, GoogleWakeRoute } from './wake-journal.js';
/** Explicit host-owned watch operations. Caller supplies a current account-bound
 * token and lifecycle fence; this adapter never starts a scheduler or listener. */
export class GmailWatch {
 constructor(private journal:Pick<GoogleWakeJournal,'recordWatch'>,private http:typeof fetch=fetch){}
 async start(route:GoogleWakeRoute,token:string,topicName:string,lifecycle:{signal?:AbortSignal;assertCurrent:()=>void|Promise<void>}) {
  if(!/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(topicName))throw Error('Invalid Gmail topic');
  const signal=lifecycle.signal?AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  signal.throwIfAborted();await abortRace(Promise.resolve(lifecycle.assertCurrent()),signal);signal.throwIfAborted();
  const response=await abortRace(this.http('https://gmail.googleapis.com/gmail/v1/users/me/watch',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({topicName}),signal,redirect:'error'}),signal);
  if(!response.ok)throw Error(`Gmail watch ${response.status}`);
  const data=await boundedJson(response,65536,signal),expiresAt=Number(data.expiration);
  signal.throwIfAborted();await abortRace(Promise.resolve(lifecycle.assertCurrent()),signal);signal.throwIfAborted();
  if(typeof data.historyId!=='string'||!/^\d{1,128}$/.test(data.historyId)||typeof data.expiration!=='string'||!/^\d{1,16}$/.test(data.expiration)||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+8*86400000)throw Error('Invalid Gmail watch response');
  this.journal.recordWatch(route,data.historyId,expiresAt);return {historyId:data.historyId,expiresAt};
 }
 async stop(token:string,lifecycle:{signal?:AbortSignal;assertCurrent:()=>void|Promise<void>}) {
  const signal=lifecycle.signal?AbortSignal.any([lifecycle.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  signal.throwIfAborted();await abortRace(Promise.resolve(lifecycle.assertCurrent()),signal);signal.throwIfAborted();
  const response=await abortRace(this.http('https://gmail.googleapis.com/gmail/v1/users/me/stop',{method:'POST',headers:{Authorization:`Bearer ${token}`},signal,redirect:'error'}),signal);
  // Disposal is best-effort: a noncooperative stream must not hold shutdown.
  void response.body?.cancel().catch(()=>{});
  signal.throwIfAborted();await abortRace(Promise.resolve(lifecycle.assertCurrent()),signal);signal.throwIfAborted();if(!response.ok)throw Error(`Gmail stop ${response.status}`);
 }
}
