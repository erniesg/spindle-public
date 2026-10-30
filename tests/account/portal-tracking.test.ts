// Tracking lane checks. The DOM is a labelled minimal fake (no browser, no
// visual evidence). Backend tests use a real tracking server, a real
// AccountClient and invented device uploads; fixture clients are labelled.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import type {Operation} from '../../core/tracking/types.js';
import {createTracking,mountTracking,parseHistory} from '../../core/account/portal/tracking.js';
import type {PortalContext} from '../../core/account/portal/types.js';

type Listener=(event:{type:string;currentTarget:FakeElement})=>void;
class Events {
 listeners=new Map<string,Set<Listener>>();
 addEventListener(type:string,fn:Listener){(this.listeners.get(type)??this.listeners.set(type,new Set()).get(type)!).add(fn);}
 removeEventListener(type:string,fn:Listener){this.listeners.get(type)?.delete(fn);}
 get listenerCount(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0);}
}
class FakeElement extends Events {
 children:FakeElement[]=[];attrs=new Map<string,string>();className='';hidden=false;disabled=false;type='';value='';own?:string;
 constructor(readonly tagName:string,readonly ownerDocument:FakeDocument){super();}
 get textContent():string{return this.own??this.children.map(c=>c.textContent).join('');}
 set textContent(value:string){this.children=[];this.own=String(value);}
 append(...nodes:(FakeElement|string)[]){
  if(this.own!==undefined){const t=new FakeElement('#text',this.ownerDocument);t.own=this.own;this.own=undefined;this.children.push(t);}
  for(const n of nodes){if(typeof n==='string'){const t=new FakeElement('#text',this.ownerDocument);t.own=n;this.children.push(t);}else this.children.push(n);}
 }
 replaceChildren(...nodes:(FakeElement|string)[]){this.children=[];this.own=undefined;this.append(...nodes);}
 setAttribute(k:string,v:string){this.attrs.set(k,String(v));}
 getAttribute(k:string){return this.attrs.get(k)??null;}
 click(){for(const fn of [...this.listeners.get('click')??[]])fn({type:'click',currentTarget:this});}
 change(){for(const fn of [...this.listeners.get('change')??[]])fn({type:'change',currentTarget:this});}
 all(cls:string):FakeElement[]{return [...(this.className.split(' ').includes(cls)?[this]:[]),...this.children.flatMap(c=>c.all(cls))];}
 one(cls:string){const found=this.all(cls)[0];assert.ok(found,`missing .${cls}`);return found;}
}
class FakeDocument extends Events {
 created:string[]=[];visibilityState='visible';defaultView=new Events();
 createElement(tag:string){this.created.push(tag);return new FakeElement(tag,this);}
}
function harness(client:unknown){
 const doc=new FakeDocument(),root=doc.createElement('div'),controller=new AbortController(),errors:unknown[]=[];
 const context={root,client,signal:controller.signal,onError:(e:unknown)=>errors.push(e)} as unknown as PortalContext;
 return {doc,root,controller,errors,context};
}
async function until(check:()=>boolean,label:string,ms=5000){
 const end=Date.now()+ms;while(!check()){if(Date.now()>end)assert.fail(`timeout: ${label}`);await new Promise(r=>setTimeout(r,5));}
}
/** Labelled API fixture: an in-memory stand-in for AccountClient.request only. */
function fixtureClient(handler:(path:string)=>unknown,account={id:'00000000-0000-4000-8000-000000000001',name:'invented-user'}){
 const calls:string[]=[];let current:typeof account|undefined=account;
 return {calls,origin:'https://account.invalid',get account(){return current;},set account(v){current=v;},
  async request(path:string,data:unknown,signal?:AbortSignal){assert.equal(data,undefined);assert.ok(signal);calls.push(path);const value=await handler(path);if(value instanceof Error)throw value;return value;}};
}
const visit=(seq:number,deviceId='d1',title='Invented title')=>({key:`k${seq}`,deviceId,recordingId:'r',visitId:`v${seq}`,seq,deleted:false,record:{wallAnchor:1_000_000,monotonicAnchor:0,visit:{app:'invented-editor',title,text:'',browser:false,start:seq*1000,end:seq*1000+500,expiresAt:Date.now()+60000}}});

test('fixture API: history pages by cursor, untrusted text stays text, and unmount stops everything',async()=>{
 const client=fixtureClient(path=>{
  if(path==='/devices')return {devices:[{id:'d1',name:'<b>Invented Mac</b>',lastUploadAt:null,pending:'unknown',uploadError:'unknown'}]};
  if(path.startsWith('/sessions'))return {from:0,to:1,personTime:0,perDevice:{},visits:[],blocks:[],anomalies:[],attribution:''};
  const cursor=Number(new URL(path,'https://x').searchParams.get('cursor'));
  if(cursor===0)return {entries:Array.from({length:16},(_,i)=>visit(i+1,'d1',i===0?'<img src=x onerror=alert(1)>':'Invented title')),cursor:16,hasMore:true};
  if(cursor===16)return {entries:[visit(17),{key:'k1',deviceId:'d1',recordingId:'r',visitId:'v1',seq:18,deleted:true},{bogus:true}],cursor:18,hasMore:false};
  throw Error('unexpected '+path);
 });
 const timers=new Set<number>();let id=0;
 const {doc,root,controller,errors,context}=harness(client);
 const dispose=createTracking(context,{pagesPerSync:1,setTimer:()=>{timers.add(++id);return id;},clearTimer:t=>timers.delete(t as number)});
 const view=root.one('tracking-view');
 await until(()=>view.one('tracking-sync').textContent.startsWith('Up to date'),'first page');
 assert.deepEqual(client.calls.filter(p=>p.startsWith('/history')),['/history?cursor=0&limit=16']);
 assert.equal(view.all('tracking-entry').length,16);assert.equal(view.one('tracking-more').hidden,false);
 assert.ok(view.textContent.includes('<img src=x onerror=alert(1)>'));assert.ok(view.textContent.includes('<b>Invented Mac</b>'));
 assert.ok(!doc.created.includes('img')&&!doc.created.includes('b'),'untrusted markup must not create elements');
 assert.ok(view.textContent.includes('No accepted upload yet'));assert.ok(view.textContent.includes('not reported to the account'));
 view.one('tracking-more').click();
 await until(()=>view.one('tracking-more').hidden,'second page');
 assert.equal(client.calls.at(-1),'/history?cursor=16&limit=16');
 // k1 was replaced by its later tombstone; the malformed entry is skipped, not invented.
 assert.equal(view.all('tracking-entry').length,17);assert.equal(view.all('tracking-entry-deleted').length,1);
 assert.match(view.one('tracking-history-meta').textContent,/1 unreadable item skipped/);
 // Truthful onboarding: download and native state are not invented.
 const states=view.all('tracking-step').map(s=>s.getAttribute('data-state'));
 assert.deepEqual(states,['done','action','action','unknown','unknown','done','unknown','unknown','pending']);
 assert.match(view.textContent,/Downloads and SHA-256 catalogue/);
 assert.ok(!/https?:\/\/\S+\.zip/.test(view.textContent),'no invented download URL');
 assert.equal(timers.size,1,'one poll scheduled');assert.ok(doc.listenerCount+doc.defaultView.listenerCount>0);
 controller.abort();
 assert.equal(root.children.length,0);assert.equal(timers.size,0);
 assert.equal(doc.listenerCount+doc.defaultView.listenerCount,0);assert.deepEqual(errors,[]);
 dispose();
});

test('fixture API: offline retries with backoff, sign-in loss reports once, and account change never paints',async()=>{
 let mode:'offline'|'ok'|'signin'='offline';
 const client=fixtureClient(path=>{
  if(mode==='offline')return Error('ACCOUNT_HTTP_503');
  if(mode==='signin')return Error('ACCOUNT_HTTP_401');
  if(path==='/devices')return {devices:[]};
  if(path.startsWith('/sessions'))return {from:0,to:1,personTime:0,perDevice:{},visits:[],blocks:[],anomalies:[],attribution:''};
  return {entries:[],cursor:0,hasMore:false};
 });
 const waits:number[]=[];let pending:(()=>void)|undefined;
 const {root,errors,context}=harness(client);
 const dispose=createTracking(context,{setTimer:(run,ms)=>{waits.push(ms);pending=run;return ms;},clearTimer:()=>{pending=undefined;}});
 const view=root.one('tracking-view'),sync=view.one('tracking-sync');
 await until(()=>/Retrying in 2s/.test(sync.textContent),'first retry');
 assert.match(view.one('tracking-history-error').textContent,/unavailable \(503\)/);
 pending!();await until(()=>/Retrying in 4s/.test(sync.textContent),'backoff');
 mode='ok';pending!();await until(()=>sync.textContent.startsWith('Up to date'),'reconnected');
 assert.deepEqual(waits,[2000,4000,30000]);
 assert.match(view.one('tracking-devices-empty').textContent,/No devices are connected/);
 assert.match(view.one('tracking-history-empty').textContent,/No history yet/);
 mode='signin';view.one('tracking-refresh').click();
 await until(()=>errors.length===1,'signin reported');
 assert.match(sync.textContent,/Sign in again/);view.one('tracking-refresh').click();
 await new Promise(r=>setTimeout(r,20));assert.equal(errors.length,1);
 dispose();
 // A reply that lands after the account changed must not paint into the new view.
 let release:(v:unknown)=>void=()=>{};
 const slow=fixtureClient(path=>path==='/devices'?new Promise(r=>{release=r;}):{entries:[],cursor:0,hasMore:false});
 const second=harness(slow);createTracking(second.context,{setTimer:()=>0,clearTimer:()=>{}});
 slow.account={id:'00000000-0000-4000-8000-000000000002',name:'other-invented'};
 release({devices:[{id:'d9',name:'Stale device',lastUploadAt:1}]});
 await new Promise(r=>setTimeout(r,20));
 assert.ok(!second.root.textContent.includes('Stale device'));
 second.controller.abort();assert.equal(second.root.children.length,0);
});

test('history parser rejects regressing cursors and unbounded pages',()=>{
 assert.throws(()=>parseHistory({entries:[],cursor:3,hasMore:false},4),/TRACKING_INVALID_RESPONSE/);
 assert.throws(()=>parseHistory({entries:Array(17).fill({}),cursor:20,hasMore:true},0),/TRACKING_INVALID_RESPONSE/);
 assert.equal(parseHistory({entries:[visit(5)],cursor:4,hasMore:false},0).skipped,1,'entry beyond cursor is not trusted');
});

test('real backend: same-account devices/history/summary persist across remount, other accounts see nothing',async()=>{
 // Invented device uploads through the existing TrackingClient; NOT native capture or multi-device acceptance.
 const dir=await mkdtemp(join(tmpdir(),'spindle-portal-tracking-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const mounts:(()=>void)[]=[];
 try{
  const password='invented-password-portal';
  const mac=new TrackingClient(server.origin,join(dir,'mac'),randomBytes(32));
  await mac.signin('invented-tracking',password,'Invented Mac',true);
  const deviceId=(await mac.inspect()).deviceId!,now=Date.now(),wall=now-600000;
  for(let n=0;n<18;n++){
   const visitId=`visit-${n}`,start=n*20000,end=start+15000;
   const op:Operation={id:randomUUID(),deviceId,recordingId:'invented-recording',visitId,record:{schema:'spindle-tracking/v1',deviceId,recordingId:'invented-recording',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:wall,monotonicAnchor:0,observedAt:end,expiresAt:now+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:end,coverage:'observed'},visit:{id:visitId,key:'invented/window',app:'invented-editor',title:`Invented document ${n}`,start,end,clock:'invented-clock',revision:1,browser:false,text:'invented',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:start,framePTS:null,expiresAt:now+900000}}};
   await mac.enqueue(op);
  }
  while((await mac.sync()).pending);
  await mac.settle();
  const mount=async(name:string,register=false)=>{
   const client=new AccountClient(server.origin);await client.signin(name,password,register);
   const h=harness(client);mounts.push(createTracking(h.context,{pollMs:600000}));
   const view=h.root.one('tracking-view');
   await until(()=>/^Up to date|could not|refused|unavailable/.test(view.one('tracking-sync').textContent),'loaded '+name);
   return {...h,view,client};
  };
  const first=await mount('invented-tracking');
  assert.match(first.view.one('tracking-sync').textContent,/^Up to date/);
  assert.equal(first.view.all('tracking-device').length,1);
  assert.equal(first.view.one('tracking-device-name').textContent,'Invented Mac');
  assert.match(first.view.one('tracking-device-upload').textContent,/^Last accepted upload /);
  // Default four pages per sync; 18 entries need two pages and end up to date.
  assert.equal(first.view.all('tracking-entry').length,18);assert.equal(first.view.one('tracking-more').hidden,true);
  assert.equal(first.view.all('tracking-entry')[0]!.one('tracking-entry-detail').textContent,'Invented document 17');
  assert.match(first.view.one('tracking-person-time').textContent,/^4m 30s observed/);
  assert.match(first.view.one('tracking-device-time').textContent,/^4m 30s observed in last 24 hours/);
  first.view.one('tracking-range').click();
  first.view.all('tracking-range')[1]!.click();
  await until(()=>first.view.all('tracking-range')[1]!.getAttribute('aria-pressed')==='true'&&!!first.view.all('tracking-person-time').length,'week range');
  first.controller.abort();
  // Reload-equivalent: a fresh client and mount read the same backend state, nothing cached locally.
  const reload=await mount('invented-tracking');
  assert.equal(reload.view.all('tracking-entry').length,18);assert.equal(reload.view.one('tracking-device-name').textContent,'Invented Mac');
  const other=await mount('invented-other',true);
  assert.equal(other.view.all('tracking-device').length,0);assert.equal(other.view.all('tracking-entry').length,0);
  assert.equal(other.view.all('tracking-step').find(s=>s.textContent.includes('Connect this Mac'))!.getAttribute('data-state'),'action');
  // A lost session surfaces as sign-in required, reported once to the shell.
  await reload.client.signout();
  reload.view.one('tracking-refresh').click();
  await until(()=>reload.errors.length===1,'signed out');
 }finally{for(const d of mounts)d();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('mountTracking is the default PortalView export',()=>{
 const client=fixtureClient(()=>new Promise(()=>{}));client.account=undefined;
 const {root,controller,context}=harness(client);
 const dispose=mountTracking(context);assert.match(root.textContent,/Sign in to see/);dispose();controller.abort();
});
