// SOURCE/TEST FIXTURE ONLY: a minimal fake DOM and a fake AccountClient transport.
// This exercises the lane component's state machine and adapter contract; it is
// not browser, extension, native-host or authenticated-backend evidence.
import {test,mock} from 'node:test';import assert from 'node:assert/strict';
import {mountBlocking,parseBlockingSnapshot,blockingFailure,type BlockingSnapshot} from '../../core/account/portal/blocking.js';
import type {AccountClient} from '../../core/account/client.js';

type Listener={type:string;fn:(event:unknown)=>void;signal?:AbortSignal};
class FakeNode {
 parent:FakeElement|undefined;
 constructor(public text=''){}
 get textContent():string{return this.text;}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=undefined;}}
}
class FakeElement extends FakeNode {
 children:FakeNode[]=[];attributes=new Map<string,string>();listeners:Listener[]=[];
 className='';id='';[key:string]:unknown;
 constructor(public tagName:string,public ownerDocument:FakeDocument){super();}
 override get textContent():string{return this.children.map(c=>c.textContent).join('');}
 override set textContent(value:string){this.replaceChildren(new FakeNode(value));}
 get firstElementChild(){return this.children.find(c=>c instanceof FakeElement) as FakeElement|undefined;}
 setAttribute(name:string,value:string){this.attributes.set(name,String(value));}
 getAttribute(name:string){return this.attributes.get(name)??null;}
 removeAttribute(name:string){this.attributes.delete(name);}
 append(...nodes:FakeNode[]){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
 prepend(...nodes:FakeNode[]){for(const n of nodes.reverse()){n.remove();n.parent=this;this.children.unshift(n);}}
 replaceChildren(...nodes:FakeNode[]){for(const c of this.children)c.parent=undefined;this.children=[];this.append(...nodes);}
 addEventListener(type:string,fn:(event:unknown)=>void,options?:{signal?:AbortSignal}){this.listeners.push({type,fn,signal:options?.signal});}
 focus(){this.ownerDocument.focused=this;}
 fire(type:string){let prevented=false;for(const l of this.listeners)if(l.type===type&&!l.signal?.aborted)l.fn({preventDefault(){prevented=true;}});return prevented;}
 all():FakeElement[]{return this.children.flatMap(c=>c instanceof FakeElement?[c,...c.all()]:[]);}
 find(name:string){return this.all().find(e=>e.getAttribute('data-blocking')===name);}
}
class FakeDocument {focused:FakeElement|undefined;createElement(tag:string){const e=new FakeElement(tag,this);if(tag==='input'){e.value='';e.checked=false;}return e;}createTextNode(text:string){return new FakeNode(text);}}

const ACCOUNT={id:'00000000-0000-4000-8000-000000000001',name:'invented-blocking-owner'};
const ready=(policy:BlockingSnapshot['policy']=null,revision=1):BlockingSnapshot=>({revision,readiness:{state:'ready',browser:'chrome',platform:'mac',observedAt:'2026-10-29T01:00:00.000Z'},policy});
const active=(over:Partial<NonNullable<BlockingSnapshot['policy']>>={})=>({host:'news.invented.test',subdomains:false,purpose:'',version:1,state:'active' as const,pausedUntil:null,appliedAt:'2026-10-29T01:00:01.000Z',...over});

function harness(handler:(path:string,data:Record<string,unknown>)=>unknown){
 const doc=new FakeDocument(),root=doc.createElement('main');
 const calls:{path:string;data:Record<string,unknown>;signal?:AbortSignal}[]=[];const errors:unknown[]=[];
 let account:typeof ACCOUNT|undefined=ACCOUNT;
 const client={get account(){return account&&{...account};},async request(path:string,data:Record<string,unknown>,signal?:AbortSignal){if(path.startsWith('/earned-leisure/'))throw http(404);calls.push({path,data,signal});return handler(path,data);}} as unknown as AccountClient;
 const shell=new AbortController();
 const unmount=mountBlocking({root:root as unknown as HTMLElement,client,signal:shell.signal,onError:e=>errors.push(e)});
 return {root,calls,errors,shell,unmount,setAccount:(a:typeof ACCOUNT|undefined)=>{account=a;},doc};
}
const settle=()=>new Promise(r=>setImmediate(r));
const http=(status:number)=>Error(`ACCOUNT_HTTP_${status}`);

test('unwired adapter (404) shows a truthful unavailable state, keeps recovery text and never mutates',async()=>{
 const h=harness(()=>{throw http(404);});
 assert.ok(h.root.find('loading'),'loading state is painted before the reply');
 await settle();
 assert.match(h.root.find('unwired')!.textContent,/not connected to your account on this server/);
 assert.equal(h.root.find('form'),undefined,'no add-rule form without a real adapter');
 assert.match(h.root.find('readiness')!.textContent,/Signed in as invented-blocking-owner/);
 assert.match(h.root.find('recovery')!.textContent,/Site blocking and recovery → Remove/);
 assert.match(h.root.find('private')!.textContent,/Incognito windows are unsupported/);
 assert.deepEqual(h.calls.map(c=>c.path),['/blocking/status']);assert.deepEqual(h.errors,[]);
 h.root.find('retry')!.fire('click');await settle();
 assert.deepEqual(h.calls.map(c=>c.path),['/blocking/status','/blocking/status']);
 h.unmount();
});

test('whole-site rule with blank purpose posts only the blocking adapter, echoes revision and renders version/state',async()=>{
 let state=ready(null,4);
 const h=harness((path,data)=>{
  if(path==='/blocking/status')return state;
  assert.equal(path,'/blocking/rule');assert.deepEqual(data,{host:'news.invented.test',subdomains:true,purpose:'',expectedRevision:4});
  state=ready(active({subdomains:true,appliedAt:null,state:'pending'}),5);return state;
 });
 await settle();
 assert.equal(h.root.find('empty')!.textContent,'No site is blocked.');
 const form=h.root.find('form')!;
 h.root.find('host-input')!.value='News.Invented.Test.';h.root.find('subdomains')!.checked=true;
 assert.equal(form.fire('submit'),true,'native form navigation is prevented');
 assert.equal(h.root.find('submit')!.disabled,true,'controls disabled while the mutation is in flight');
 await settle();
 assert.deepEqual(h.calls.map(c=>c.path),['/blocking/status','/blocking/rule'],'no purpose/model call gates a whole-site rule');
 assert.equal(h.root.find('host')!.textContent,'Change incomplete news.invented.test');
 assert.equal(h.root.find('version')!.textContent,'v1');
 assert.equal(h.root.find('purpose')!.textContent,'None. The whole site is blocked with no exceptions.');
 assert.equal(h.root.find('applied')!.textContent,'Not yet confirmed by the extension');
 assert.match(h.root.find('last')!.textContent,/Waiting for the extension to apply/);
 h.unmount();
});

test('hostname validation keeps typed input and makes no request',async()=>{
 const h=harness(()=>ready());await settle();
 const host=h.root.find('host-input')!;host.value='https://news.invented.test/a';
 h.root.find('form')!.fire('submit');
 assert.equal(h.calls.length,1);assert.equal(host.value,'https://news.invented.test/a');assert.equal(h.root.find('host-input'),host,'form not re-rendered');
 assert.match(h.root.find('last')!.textContent,/hostname only/);assert.equal(h.doc.focused,host);
 h.unmount();
});

test('explicit pause → countdown → resume → remove/recovery use the adapter; timer stops on unmount',async()=>{
 mock.timers.enable({apis:['setInterval','Date'],now:Date.parse('2026-10-29T02:00:00.000Z')});
 try{
  let state=ready(active(),7);
  const h=harness((path,data)=>{
   if(path==='/blocking/pause'){assert.deepEqual(data,{minutes:15,expectedRevision:7});state=ready(active({state:'paused',pausedUntil:'2026-10-29T02:15:00.000Z'}),8);}
   if(path==='/blocking/resume'){assert.deepEqual(data,{expectedRevision:8});state=ready(active(),9);}
   if(path==='/blocking/remove'){assert.deepEqual(data,{expectedRevision:9});state=ready(null,10);}
   return state;
  });
  await settle();
  assert.ok(h.root.find('pause-5')&&h.root.find('pause-30'));assert.equal(h.root.find('resume'),undefined);
  h.root.find('pause-15')!.fire('click');await settle();
  assert.match(h.root.find('pause-remaining')!.textContent,/about 15 more minutes/);
  const typed=h.root.find('host-input')!;typed.value='draft.invented.test';
  mock.timers.tick(5*60000);
  assert.match(h.root.find('pause-remaining')!.textContent,/about 10 more minutes/);
  assert.equal(h.root.find('host-input'),typed,'countdown never replaces the form');
  h.root.find('resume')!.fire('click');await settle();
  assert.equal(h.root.find('state')!.textContent,'Active');
  h.root.find('remove')!.fire('click');await settle();
  assert.equal(h.root.find('empty')!.textContent,'No site is blocked.');
  assert.match(h.root.find('last')!.textContent,/Block removed/);
  assert.deepEqual(h.calls.map(c=>c.path),['/blocking/status','/blocking/pause','/blocking/resume','/blocking/remove']);
  h.unmount();assert.equal(h.root.children.length,0,'lane nodes removed');
 }finally{mock.timers.reset();}
});

test('pause end reloads real state once rather than assuming the browser resumed',async()=>{
 mock.timers.enable({apis:['setInterval','Date'],now:Date.parse('2026-10-29T03:00:00.000Z')});
 try{
  let paused=true;
  const h=harness(()=>paused?ready(active({state:'paused',pausedUntil:'2026-10-29T03:00:20.000Z'})):ready(active()));
  await settle();paused=false;
  mock.timers.tick(15000);assert.equal(h.calls.length,1);
  mock.timers.tick(15000);await settle();
  assert.deepEqual(h.calls.map(c=>c.path),['/blocking/status','/blocking/status']);
  assert.equal(h.root.find('state')!.textContent,'Active');
  h.unmount();
  // Unmounting while paused clears the countdown: no timer-driven reload afterwards.
  const again=harness(()=>ready(active({state:'paused',pausedUntil:'2026-10-29T03:10:00.000Z'})));await settle();
  again.unmount();mock.timers.tick(60*60000);await settle();assert.equal(again.calls.length,1);
 }finally{mock.timers.reset();}
});

test('stale revision (409) reloads and shows the current policy from the server',async()=>{
 let n=0;
 const h=harness(path=>{if(path==='/blocking/status')return ready(active({host:n++?'other.invented.test':'news.invented.test',version:n}),n);throw http(409);});
 await settle();
 h.root.find('remove')!.fire('click');await settle();await settle();
 assert.match(h.root.find('host')!.textContent,/other\.invented\.test/);
 assert.match(h.root.find('last')!.textContent,/changed elsewhere/);
 h.unmount();
});

test('native host absent shows Unsupported and disables adding; purpose text is inert textContent',async()=>{
 const h=harness(()=>({...ready(active({purpose:'<img src=x onerror=alert(1)>'})),readiness:{state:'native_host_absent',browser:'unknown',platform:'unknown',observedAt:null}}));
 await settle();
 assert.match(h.root.find('readiness')!.textContent,/Unsupported here: the Spindle native host is not connected/);
 assert.equal(h.root.find('submit')!.disabled,true);
 const purpose=h.root.find('purpose')!;
 assert.equal(purpose.textContent,'<img src=x onerror=alert(1)>');assert.equal(purpose.children.every(c=>!(c instanceof FakeElement)),true);
 h.unmount();
});

test('unmount, shell abort and account change discard late replies (no stale cross-account paint)',async()=>{
 for(const end of ['unmount','abort','account'] as const){
  let release!:(v:unknown)=>void;
  const h=harness(()=>new Promise(r=>{release=r;}));
  await settle();const signal=h.calls[0]!.signal!;
  if(end==='unmount')h.unmount();else if(end==='abort')h.shell.abort();else h.setAccount({id:'00000000-0000-4000-8000-000000000002',name:'invented-other'});
  if(end!=='account')assert.equal(signal.aborted,true,'request signal follows lifecycle');
  release(ready(active()));await settle();
  assert.equal(h.root.find('policy'),undefined,`${end}: no late policy paint`);assert.deepEqual(h.errors,[]);
  h.unmount();
 }
});

test('malformed adapter replies are unknown, reported once, never partially trusted',async()=>{
 const bad:unknown[]=[
  {...ready(active({state:'paused'}))},
  {...ready(active({host:'https://x.test/'}))},
  {...ready(),readiness:{state:'enrolled',browser:'chrome',platform:'mac',observedAt:null}},
  {...ready(),revision:-1},
 ];
 for(const raw of bad)assert.throws(()=>parseBlockingSnapshot(raw),/BLOCKING_RESPONSE_INVALID/);
 assert.deepEqual(parseBlockingSnapshot(ready(active())),ready(active()));
 const h=harness(()=>bad[0]);await settle();
 assert.match(h.root.find('error')!.textContent,/unrecognised blocking state/);assert.equal(h.errors.length,1);
 h.unmount();
 assert.equal(blockingFailure(http(401)).kind,'signin');assert.equal(blockingFailure(http(503)).kind,'server');assert.equal(blockingFailure(new TypeError('fetch failed')).kind,'network');
});
