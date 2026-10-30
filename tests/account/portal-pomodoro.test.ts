import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AccountClient} from '../../core/account/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {mountPomodoro} from '../../core/account/portal/pomodoro.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';

// Actual account HTTP service, cookie/Origin/CSRF and AccountClient. The DOM below is a minimal
// labelled test double (Node has no DOM); browser rendering is covered by portal-pomodoro.e2e.ts.
class FakeElement {
 validity={badInput:false};
 getContext(){return null;} // No canvas in this labelled Node DOM double; actual drawing has browser proof.
 className='';hidden=false;disabled=false;type='';value='';min='';max='';step='';dataset:Record<string,string>={};
 children:(FakeElement|string)[]=[];attributes=new Map<string,string>();listeners=new Map<string,Set<()=>void>>();
 constructor(readonly tagName:string,readonly ownerDocument:FakeDocument){}
 get textContent():string{return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 set textContent(value:string){this.children=value===''?[]:[String(value)];}
 set innerHTML(_:string){throw Error('UNSAFE_INNER_HTML');}
 append(...nodes:(FakeElement|string)[]){this.children.push(...nodes);}
 replaceChildren(...nodes:(FakeElement|string)[]){this.children=[...nodes];}
 setAttribute(name:string,value:string){this.attributes.set(name,value);}
 addEventListener(type:string,listener:()=>void){(this.listeners.get(type)??this.listeners.set(type,new Set()).get(type)!).add(listener);}
 removeEventListener(type:string,listener:()=>void){this.listeners.get(type)?.delete(listener);}
 dispatch(type:string){for(const l of this.listeners.get(type)??[])l();}
}
class FakeDocument {
 visibilityState='visible';listeners=new Map<string,Set<()=>void>>();
 createElement(tag:string){return new FakeElement(tag,this);}
 addEventListener(type:string,listener:()=>void){(this.listeners.get(type)??this.listeners.set(type,new Set()).get(type)!).add(listener);}
 removeEventListener(type:string,listener:()=>void){this.listeners.get(type)?.delete(listener);}
 get listenerCount(){let n=0;for(const s of this.listeners.values())n+=s.size;return n;}
 dispatch(type:string){for(const l of this.listeners.get(type)??[])l();}
}
function find(node:FakeElement,predicate:(e:FakeElement)=>boolean):FakeElement|undefined{
 if(predicate(node))return node;for(const c of node.children)if(typeof c!=='string'){const hit=find(c,predicate);if(hit)return hit;}
}
const byClass=(root:FakeElement,name:string)=>{const e=find(root,e=>e.className.split(' ').includes(name));assert.ok(e,`missing .${name}`);return e;};
const action=(root:FakeElement,name:string)=>{const e=find(root,e=>e.dataset.pomodoroAction===name);assert.ok(e,`missing ${name}`);return e;};
async function until(predicate:()=>boolean,what:string,timeout=4000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error(`Timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,10));}}
const password='invented-only-password';

function mount(client:AccountClient){
 const doc=new FakeDocument(),root=doc.createElement('div'),controller=new AbortController(),errors:unknown[]=[];
 // The shared core/ui primitives create elements on the global document; the test double stands in for it.
 (globalThis as {document?:unknown}).document=doc;
 const dispose=mountPomodoro({root:root as unknown as HTMLElement,client,signal:controller.signal,onError:e=>errors.push(e)});
 const view=()=>root.children[0] as FakeElement|undefined;
 const data=()=>view()?.dataset??{};
 return {doc,root,controller,errors,dispose,view,data,text:(name:string)=>byClass(view()!,name).textContent,
  click:(name:string)=>{const b=action(view()!,name);assert.equal(b.hidden,false,`${name} hidden`);assert.equal(b.disabled,false,`${name} disabled`);b.dispatch('click');},
  refresh:()=>doc.dispatch('visibilitychange'),
  online:(status?:string)=>until(()=>data().pomodoroState==='online'&&(!status||data().pomodoroStatus===status),`online ${status??''}`)};
}
async function service(){
 const scratch=process.env.RUCKSACK_SCRATCH_ROOT??join(homedir(),'.local/state/rucksack/scratch/spindle-account-tests');mkdirSync(scratch,{recursive:true});
 const directory=mkdtempSync(join(scratch,'portal-pomodoro-')),key=Buffer.alloc(32,92),server=await startTrackingServer(directory,key);
 return {server,async client(name:string,register=false,transport:typeof fetch=fetch){const c=new AccountClient(server.origin,transport);await c.signin(name,password,register);return c;},async close(){await server.close();key.fill(0);rmSync(directory,{recursive:true,force:true});}};
}
/** Test-only fetch wrapper: observes paths and can hold one request; never fabricates backend timer state. */
function observed(){
 const paths:string[]=[];let gate:Promise<void>|undefined,release=()=>{};
 const transport:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;paths.push(path);if(gate&&path==='/pomodoro/read'){const g=gate;gate=undefined;await g;}return fetch(input,init);};
 return {transport,paths,hold(){gate=new Promise(r=>{release=r;});return ()=>release();}};
}

test('two authenticated clients share one server session/revision through start, pause, reload and reset',async()=>{
 const s=await service();try{
  const a=mount(await s.client('invented-pomodoro-owner',true)),b=mount(await s.client('invented-pomodoro-owner'));
  await a.online('idle');await b.online('idle');
  assert.equal(a.data().pomodoroRevision,'0','mounting never starts a timer');assert.equal(a.text('pomodoro-countdown'),'25:00');
  const focus=byClass(a.view()!,'pomodoro-focus-minutes');focus.value='2';focus.dispatch('input');
  a.click('start');await a.online('running');
  b.refresh();await b.online('running');
  assert.equal(b.data().pomodoroSession,a.data().pomodoroSession);assert.match(a.data().pomodoroSession!,/^[a-f0-9-]{36}$/);
  assert.equal(b.data().pomodoroRevision,'1');assert.equal(a.data().pomodoroRevision,'1');
  assert.match(b.text('pomodoro-countdown'),/^0[12]:\d\d$/);
  b.click('pause');await b.online('paused');a.refresh();await a.online('paused');
  assert.equal(a.data().pomodoroRevision,'2');assert.equal(a.text('pomodoro-countdown'),b.text('pomodoro-countdown'));
  const paused=a.text('pomodoro-countdown'),session=a.data().pomodoroSession;
  // Reload: unmount the old view and mount a fresh one; only the server holds the timer.
  a.controller.abort();assert.equal(a.root.children.length,0);
  const c=mount(await s.client('invented-pomodoro-owner'));await c.online('paused');
  assert.equal(c.text('pomodoro-countdown'),paused);assert.equal(c.data().pomodoroSession,session);assert.equal(c.data().pomodoroRevision,'2');
  await new Promise(r=>setTimeout(r,1100));assert.equal(c.text('pomodoro-countdown'),paused,'paused time does not tick');
  c.click('reset');await c.online('idle');b.refresh();await b.online('idle');
  assert.equal(b.data().pomodoroRevision,'3');assert.equal(b.data().pomodoroSession,'');assert.equal(b.text('pomodoro-countdown'),'02:00');
  const truth=await (await s.client('invented-pomodoro-owner')).request('/pomodoro') as Snapshot;
  assert.equal(truth.timer.revision,3);assert.equal(truth.timer.status,'idle');assert.equal(truth.timer.durations.focusMs,120000);
  assert.deepEqual([...a.errors,...b.errors,...c.errors],[]);b.dispose();c.dispose();
 }finally{await s.close();}
});

test('stale revision conflict is shown, never replayed, then reconciled by a read',async()=>{
 const s=await service();try{
  const a=mount(await s.client('invented-pomodoro-race',true)),watch=observed(),b=mount(await s.client('invented-pomodoro-race',false,watch.transport));
  await a.online('idle');await b.online('idle');a.click('start');await a.online('running');b.refresh();await b.online('running');b.doc.visibilityState='hidden'; // no background poll may consume the held read
  a.click('pause');await a.online('paused');
  const release=watch.hold(),before=watch.paths.length;b.click('pause');
  await until(()=>b.data().pomodoroState==='conflict','conflict');
  assert.match(b.text('pomodoro-error'),/Another client changed the timer first/);assert.equal(action(b.view()!,'pause').disabled,true);
  release();await b.online('paused');
  assert.deepEqual(watch.paths.slice(before),['/pomodoro/command','/pomodoro/read']);assert.equal(b.data().pomodoroRevision,'2');
  a.dispose();b.dispose();
 }finally{await s.close();}
});

test('lost command response is uncertain; refresh shows the committed state without replay',async()=>{
 const s=await service();try{
  let lose=false,commands=0;
  const lossy:typeof fetch=async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/pomodoro/command')){commands++;if(lose){lose=false;await response.body?.cancel();throw TypeError('fetch failed');}}return response;};
  const v=mount(await s.client('invented-pomodoro-lossy',true,lossy));await v.online('idle');
  lose=true;v.click('start');await until(()=>v.data().pomodoroState==='uncertain','uncertain');
  assert.match(v.text('pomodoro-error'),/may already have applied/);assert.equal(action(v.view()!,'start').disabled,true);
  byClass(v.view()!,'pomodoro-refresh').dispatch('click');await v.online('running');
  assert.equal(commands,1);assert.equal(v.data().pomodoroRevision,'1');v.dispose();
 }finally{await s.close();}
});

test('abort clears timers, listeners and DOM; late replies never repaint',async()=>{
 const s=await service();const realSet=globalThis.setInterval,realClear=globalThis.clearInterval,live=new Set<unknown>();
 globalThis.setInterval=((fn:()=>void,ms:number)=>{const id=realSet(fn,ms);live.add(id);return id;}) as typeof setInterval;
 globalThis.clearInterval=((id:Parameters<typeof clearInterval>[0])=>{live.delete(id);realClear(id);}) as typeof clearInterval;
 try{
  const watch=observed(),v=mount(await s.client('invented-pomodoro-abort',true,watch.transport));await v.online('idle');
  assert.equal(live.size,2);assert.equal(v.doc.listenerCount,1);
  const release=watch.hold();v.refresh();await until(()=>watch.paths.at(-1)==='/pomodoro/read','held read');
  v.controller.abort();
  assert.equal(live.size,0);assert.equal(v.doc.listenerCount,0);assert.equal(v.root.children.length,0);
  const count=watch.paths.length;release();await new Promise(r=>setTimeout(r,200));
  assert.equal(v.root.children.length,0);assert.equal(watch.paths.length,count);assert.deepEqual(v.errors,[]);
  v.dispose(); // idempotent
  const already=new AbortController();already.abort();const doc=new FakeDocument(),root=doc.createElement('div');
  mountPomodoro({root:root as unknown as HTMLElement,client:new AccountClient(s.server.origin),signal:already.signal,onError:()=>assert.fail()})();
  assert.equal(root.children.length,0);assert.equal(live.size,0);
 }finally{globalThis.setInterval=realSet;globalThis.clearInterval=realClear;await s.close();}
});

test('ended account session clears the timer and reports once to the shell',async()=>{
 const s=await service();try{
  const client=await s.client('invented-pomodoro-session',true),v=mount(client);await v.online('idle');
  await client.signout();v.refresh();
  await until(()=>v.errors.length===1&&v.data().pomodoroState==='signed-out','signed out');
  assert.equal(v.text('pomodoro-countdown'),'—');assert.equal(v.data().pomodoroRevision,'');assert.equal(v.errors.length,1);
  v.refresh();await new Promise(r=>setTimeout(r,50));assert.equal(v.errors.length,1);v.dispose();
  // A never-signed-in client sends nothing and shows signed-out rather than any timer.
  const anonymous=mount(new AccountClient(s.server.origin));await until(()=>anonymous.data().pomodoroState==='signed-out','anonymous');
  assert.equal(anonymous.text('pomodoro-countdown'),'—');anonymous.dispose();
 }finally{await s.close();}
});

test('labelled fixture: a service without the timer route renders unsupported, not a fake timer',async()=>{
 const s=await service();try{
  const missing:typeof fetch=async(input,init)=>String(input).endsWith('/pomodoro/read')?new Response('{"error":"NOT_FOUND"}',{status:404}):fetch(input,init);
  const v=mount(await s.client('invented-pomodoro-old',true,missing));
  await until(()=>v.data().pomodoroState==='unsupported','unsupported');
  assert.match(v.text('pomodoro-error'),/does not offer the shared timer/);assert.equal(v.text('pomodoro-countdown'),'—');
  assert.equal(byClass(v.view()!,'pomodoro-refresh').disabled,true);v.dispose();
 }finally{await s.close();}
});
