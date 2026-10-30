import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPomodoroDispatch} from '../../browser-extension/pomodoro/dispatch.js';

test('timer dispatch checks own exact page, rejects excess authority and has a dedicated single slot',async()=>{
 const id='a'.repeat(32),url=`chrome-extension://${id}/pomodoro/pomodoro.html`,request={action:'read',binding:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};
 let listener!:(message:unknown,sender:chrome.runtime.MessageSender,reply:(v:unknown)=>void)=>unknown;
 const previous=globalThis.chrome;
 globalThis.chrome={runtime:{id,getURL:(path:string)=>`chrome-extension://${id}/${path}`,onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}}} as unknown as typeof chrome;
 try{
  let calls=0,resolve!:(v:{ok:boolean;value?:unknown})=>void;
  installPomodoroDispatch(async()=>{calls++;return new Promise(r=>{resolve=r;});});
  const responses:unknown[]=[];const reply=(v:unknown)=>responses.push(v);
  for(const [message,sender] of [
   [{kind:'pomodoro',request},{id:'b'.repeat(32),url}],
   [{kind:'pomodoro',request},{id,url:'https://untrusted.example'}],
   [{kind:'pomodoro',request},{id,url:`chrome-extension://${id}/options.html`}],
   [{kind:'pomodoro',request:{action:'read',accountId:'other'}},{id,url}],
   [{kind:'pomodoro',request:{action:'signin'}},{id,url}],
   [{kind:'pomodoro',request:{action:'command',command:{id:'bad',expectedRevision:0,action:'reset',accountId:'other'}}},{id,url}],
  ] as [unknown,chrome.runtime.MessageSender][])assert.equal(listener(message,sender,reply),undefined);
  assert.equal(calls,0);assert.equal(responses.length,6);
  assert.equal(listener({kind:'pomodoro',request},{id,url},reply),true);assert.equal(calls,1);
  assert.equal(listener({kind:'pomodoro',request},{id,url},reply),undefined);assert.equal(calls,1);
  // Unrelated capture/revoke/purpose messages aren't claimed by this listener.
  assert.equal(listener({kind:'revoke'},{id,url},reply),undefined);assert.equal(calls,1);
  resolve({ok:true,value:{marker:'invented'}});await new Promise(r=>setImmediate(r));
  assert.deepEqual(responses.at(-1),{ok:true,value:{marker:'invented'}});
  assert.equal(listener({kind:'pomodoro',request},{id,url},reply),true);assert.equal(calls,2);
  resolve({ok:false});await new Promise(r=>setImmediate(r));
 }finally{globalThis.chrome=previous;}
});
