// Portal classification + study->leisure controls. Real tracking server over HTTP and a real
// AccountClient with invented accounts. The model is a real TextProvider on a SCRIPTED
// transport (no network, credential or paid call). The DOM used for the earned-leisure card is
// a labelled minimal fake; rendering in a real browser is covered by portal-demo.e2e.ts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {AccountClient} from '../../core/account/client.js';
import {categoryIds} from '../../core/classification/types.js';
import {recordKey,type Operation} from '../../core/tracking/types.js';
import {observation,scripted,type ClassificationConfig} from './portal-demo-fixture.js';
import {ClassificationFlow,CLASSIFY_CATEGORIES,AUTO_BATCH,parseClassificationConfig,parseClassifyOutcome,parseSummary,outcomeText,type FlowHost,type SummaryVisit} from '../../core/account/portal/tracking.js';
import {createBlocking,parseEarned,type EarnedAdapter,type EarnedLease} from '../../core/account/portal/blocking.js';
import type {PortalContext} from '../../core/account/portal/types.js';

async function setup(config?:ClassificationConfig){
 const dir=await mkdtemp(join(tmpdir(),'portal-demo-')),server=await startTrackingServer(join(dir,'server'),randomBytes(32),0,undefined,undefined,undefined,undefined,undefined,config);
 const collector=new TrackingClient(server.origin,join(dir,'collector'),randomBytes(32));
 await collector.signin('invented-demo-owner','invented-password-123','Invented Mac',true);
 const client=new AccountClient(server.origin);await client.signin('invented-demo-owner','invented-password-123');
 const deviceId=(await collector.inspect()).deviceId!;
 const upload=async(op:Operation)=>{await collector.enqueue(op);while((await collector.sync()).pending);await collector.settle();return recordKey(op);};
 return {dir,server,collector,client,deviceId,upload,close:async()=>{await server.close();await rm(dir,{recursive:true,force:true});}};
}
/** A FlowHost over the real AccountClient. `lose` simulates a reply lost after the server already acted. */
function flowOf(client:AccountClient,lose?:{path:string;armed:boolean}){
 let rows:SummaryVisit[]=[];const controller=new AbortController(),signins:unknown[]=[],paths:string[]=[],owner=client.account!.id;
 const host:FlowHost={
  signal:controller.signal,live:()=>client.account?.id===owner,rows:()=>rows,changed(){},signin:e=>{signins.push(e);},
  async request(path,data,signal){
   paths.push(path);const reply=await client.request(path,data,signal);
   if(lose?.armed&&path===lose.path){lose.armed=false;throw new TypeError('fetch failed');}
   return reply;
  },
  async reread(){const to=Date.now()+1000;rows=parseSummary(await client.request(`/sessions?from=${to-86400000}&to=${to}`)).rows;},
 };
 return {host,flow:new ClassificationFlow(host),controller,signins,paths,rows:()=>rows};
}
const row=(rows:SummaryVisit[],key:string)=>rows.find(r=>r.key===key)!;

test('category choices match the service vocabulary and malformed replies are rejected, not trusted',()=>{
 assert.deepEqual(CLASSIFY_CATEGORIES.map(c=>c[0]),[...categoryIds]);
 assert.deepEqual(parseClassificationConfig({configured:false}),{configured:false});
 const legacy=parseClassificationConfig({configured:true,model:{provider:'nebius',id:'m',vision:false},paused:false,processing:true,consent:null});
 assert.ok(legacy.configured);assert.equal(legacy.quota,undefined,'older servers without quota remain readable');
 assert.throws(()=>parseClassificationConfig({configured:true,model:{provider:'nebius',id:'m',vision:false},paused:false,processing:true,consent:null,quota:{perMinute:2,perDay:12,usedMinute:3,usedDay:3,clockTrusted:true}}));
 assert.throws(()=>parseClassificationConfig({configured:true,model:{provider:'nebius',id:'m',vision:false},paused:false,processing:true,consent:{revision:1,fields:['everything']}}));
 assert.throws(()=>parseClassifyOutcome({requestId:'other',key:'k',evidenceRevision:1,state:'done',status:'suggested'},{requestId:'r',key:'k',evidenceRevision:1}));
 assert.match(outcomeText(parseClassifyOutcome({requestId:'r',key:'k',evidenceRevision:1,state:'done',status:'<img src=x onerror=alert(1)>'.slice(0,0)+'RATE_LIMITED'},{requestId:'r',key:'k',evidenceRevision:1})),/RATE_LIMITED/);
 assert.throws(()=>parseClassifyOutcome({requestId:'r',key:'k',evidenceRevision:1,state:'done',status:'<script>'},{requestId:'r',key:'k',evidenceRevision:1}),'provider text must be a short code or it is refused');
 assert.throws(()=>parseEarned({configured:true,enabled:true,balance:{earnedSeconds:5,spentSeconds:0,availableSeconds:9,basis:'x'},policy:{ratio:1,windowHours:24,minimumSeconds:30,maximumSeconds:1800}}));
});

test('explicit consent gates the model; one request per action; the label reads back as an AI suggestion, never as the user\'s own',async()=>{
 const script=scripted(),s=await setup(script.config);
 try{
  const key=await s.upload(observation(s.deviceId,Date.now()-100000));
  const f=flowOf(s.client);await f.host.reread();await f.flow.loadConfig();
  assert.deepEqual(f.flow.model,{provider:'nebius',id:'invented/classifier',vision:false});
  assert.equal(row(f.rows(),key).label,null,'local processing is off by default: no label is shown');
  assert.match(f.flow.reason(row(f.rows(),key))!,/label processing/);
  await f.flow.classify(row(f.rows(),key));assert.equal(script.calls.length,0,'nothing is sent without processing and explicit consent');
  await f.flow.setProcessing(true);
  assert.match(f.flow.reason(row(f.rows(),key))!,/Allow remote classification/);
  await f.flow.classify(row(f.rows(),key));assert.equal(script.calls.length,0);
  await f.flow.grant(['title','text']);assert.deepEqual(f.flow.consentedFields,['title','text']);
  assert.equal(f.flow.reason(row(f.rows(),key)),undefined);
  const before=f.paths.length;await f.flow.classify(row(f.rows(),key));
  assert.equal(script.calls.length,1,'exactly one provider call');
  assert.ok(!script.calls[0]!.includes('invented-server-key'));
  const after=row(f.rows(),key);
  assert.equal(after.label!.source,'inference');assert.equal(after.label!.provider,'nebius');assert.equal(after.label!.model,'invented/classifier');assert.equal(after.label!.categoryId,'learning');
  assert.match(f.flow.noteFor(after)!.text,/not your label until you confirm/);
  assert.ok(f.paths.slice(before).includes('/classification/classify'));
  await f.flow.classify(after);assert.equal(script.calls.length,1,'the same item and revision never pays twice');
  await f.flow.confirm(after,'learning');
  const mine=row(f.rows(),key);assert.equal(mine.label!.source,'override','only the explicit confirm creates the user\'s own label');
  assert.match(f.flow.reason(mine)!,/Your own label is kept/);
  await f.flow.classify(mine);assert.equal(script.calls.length,1);
  await f.flow.revoke();assert.equal(f.flow.consentedFields.length,0);
 }finally{await s.close();}
});

test('a reply lost after the server acted is read back by the same request ID, never paid for again',async()=>{
 const script=scripted(),s=await setup(script.config);
 try{
  const key=await s.upload(observation(s.deviceId,Date.now()-100000));
  const lose={path:'/classification/classify',armed:true},f=flowOf(s.client,lose);
  await f.host.reread();await f.flow.loadConfig();await f.flow.setProcessing(true);await f.flow.grant(['title','text']);
  await f.flow.classify(row(f.rows(),key));
  assert.equal(script.calls.length,1,'the server dispatched once before the reply was lost');
  assert.equal(f.flow.uncertain(row(f.rows(),key)),true);assert.match(f.flow.noteFor(row(f.rows(),key))!.text,/could not be confirmed.*not retried/);
  await f.flow.classify(row(f.rows(),key));
  assert.equal(script.calls.length,1,'readback, not a second paid call');
  assert.ok(f.paths.includes('/classification/status'));
  assert.equal(f.flow.uncertain(row(f.rows(),key)),false);assert.equal(row(f.rows(),key).label!.source,'inference');
 }finally{await s.close();}
});

test('automatic mode needs consent, starts empty, handles only new text one at a time and stops on revoke or sign-out',async()=>{
 const script=scripted(),s=await setup(script.config);
 try{
  const old=await s.upload(observation(s.deviceId,Date.now()-200000));
  const f=flowOf(s.client);await f.host.reread();await f.flow.loadConfig();
  f.flow.setAuto(true);assert.equal(f.flow.auto,false,'cannot turn on without processing and consent');
  await f.flow.setProcessing(true);f.flow.setAuto(true);assert.equal(f.flow.auto,false);
  await f.flow.grant(['text']);f.flow.setAuto(true);assert.equal(f.flow.auto,true);
  await f.flow.afterSync();assert.equal(script.calls.length,0,'earlier uploads are never swept up');
  const fresh=await s.upload(observation(s.deviceId,Date.now()-100000));await f.host.reread();
  await f.flow.afterSync();assert.equal(script.calls.length,1);
  assert.equal(row(f.rows(),fresh).label!.source,'inference');assert.equal(row(f.rows(),old).label!.source,'abstention');
  await f.flow.afterSync();assert.equal(script.calls.length,1,'no repeat for an item already handled');
  const outside=flowOf(s.client);await outside.host.reread();await outside.flow.loadConfig();
  assert.equal(outside.flow.auto,false,'a new view starts with automatic off');
  await f.flow.revoke();assert.equal(f.flow.auto,false);
  const third=await s.upload(observation(s.deviceId,Date.now()-90000));await f.host.reread();
  await f.flow.afterSync();assert.equal(script.calls.length,1,'revoked: dispatch stopped');
  assert.ok(AUTO_BATCH>=3&&AUTO_BATCH<=5);
  await f.flow.grant(['text']);f.flow.setAuto(true);await s.upload(observation(s.deviceId,Date.now()-80000));await f.host.reread();
  await s.client.signout();await f.flow.afterSync();await f.flow.classify(row(f.rows(),third));
  assert.equal(script.calls.length,1,'signed out: nothing dispatched');
 }finally{await s.close();}
});

test('automatic classification stops at the served quota before creating another request ID',async()=>{
 const script=scripted(),s=await setup({...script.config,quota:{perMinute:1,perDay:12}});
 try{
  const f=flowOf(s.client);await f.host.reread();await f.flow.loadConfig();await f.flow.setProcessing(true);await f.flow.grant(['text']);
  f.flow.setAuto(true);assert.equal(f.flow.auto,true);
  await s.upload(observation(s.deviceId,Date.now()-100000));await s.upload(observation(s.deviceId,Date.now()-90000));await f.host.reread();
  await f.flow.afterSync();
  assert.equal(script.calls.length,1,'the server admitted only the first automatic classification');
  assert.equal(f.paths.filter(path=>path==='/classification/classify').length,1,'the refreshed quota prevents a second request ID');
  assert.equal(f.flow.auto,false,'automatic mode turns off when the declared quota is exhausted');
  assert.match(f.flow.cardNote!.text,/quota/i);
  const config=f.flow.config;assert.ok(config?.configured);
  assert.deepEqual((config as unknown as {quota:unknown}).quota,{perMinute:1,perDay:12,usedMinute:1,usedDay:1,clockTrusted:true});
 }finally{await s.close();}
});

test('a quota refusal is definite and stops the automatic batch',async()=>{
 let rows:SummaryVisit[]=[];const requests:unknown[]=[];
 const host:FlowHost={
  signal:new AbortController().signal,live:()=>true,rows:()=>rows,changed(){},signin(){},reread:async()=>{},
  async request(path,data){
   if(path==='/classification/config')return {configured:true,model:{provider:'invented',id:'classifier',vision:false},paused:false,processing:true,consent:{revision:1,fields:['text']},quota:{perMinute:2,perDay:12,usedMinute:0,usedDay:0,clockTrusted:true}};
   if(path==='/classification/classify'){requests.push(data);throw Error('ACCOUNT_HTTP_429');}
   throw Error(`unexpected ${path}`);
  },
 };
 const flow=new ClassificationFlow(host);await flow.loadConfig();flow.setAuto(true);
 rows=['one','two'].map(key=>({key,evidenceRevision:1,correctionRevision:0,open:false,label:{source:'abstention',categoryId:'uncategorized',activityId:null,relatedIds:[],provider:null,model:null},textState:'available',titleChars:0,textChars:80}));
 await flow.afterSync();
 assert.equal(requests.length,1,'a definite quota refusal does not create more automatic IDs');
 assert.equal(flow.auto,false);assert.match(flow.noteFor(rows[0]!)!.text,/quota.*outcome is confirmed/i);assert.doesNotMatch(flow.noteFor(rows[0]!)!.text,/unconfirmed/i);
});

test('manual classification waits for a fresh trusted quota clock',async()=>{
 let trusted=false;const requests:string[]=[];
 const host:FlowHost={
  signal:new AbortController().signal,live:()=>true,rows:()=>[],changed(){},signin(){},reread:async()=>{},
  async request(path){
   requests.push(path);
   if(path==='/classification/config')return {configured:true,model:{provider:'invented',id:'classifier',vision:false},paused:false,processing:true,consent:{revision:1,fields:['text']},quota:{perMinute:2,perDay:12,usedMinute:0,usedDay:0,clockTrusted:trusted}};
   throw Error(`unexpected ${path}`);
  },
 };
 const flow=new ClassificationFlow(host),item:SummaryVisit={key:'one',evidenceRevision:1,correctionRevision:0,open:false,label:{source:'abstention',categoryId:'uncategorized',activityId:null,relatedIds:[],provider:null,model:null},textState:'available',titleChars:0,textChars:80};
 await flow.loadConfig();assert.match(flow.reason(item)!,/clock is untrusted.*Refresh/i);
 await flow.classify(item);assert.deepEqual(requests,['/classification/config'],'manual classification does not send while the server clock is untrusted');
 trusted=true;await flow.loadConfig();assert.equal(flow.reason(item),undefined,'a fresh trusted server configuration restores manual classification');
});

test('unconfigured or unavailable model is disabled honestly with no invented model',async()=>{
 const s=await setup();
 try{
  const f=flowOf(s.client);await f.flow.loadConfig();
  assert.deepEqual(f.flow.config,{configured:false});assert.equal(f.flow.model,undefined);assert.equal(f.flow.ready,false);
  assert.match(f.flow.reason({key:'k',evidenceRevision:1,correctionRevision:0,open:false,label:null,textState:'available',titleChars:50,textChars:50})!,/no AI model configured/);
  await f.flow.classify({key:'k',evidenceRevision:1,correctionRevision:0,open:false,label:null,textState:'available',titleChars:50,textChars:50});
  assert.ok(!f.paths.includes('/classification/classify'));
 }finally{await s.close();}
});

// ---- Study -> leisure card (labelled minimal fake DOM) ----
class FakeNode{parent:FakeElement|undefined;constructor(public text=''){}get textContent():string{return this.text;}remove(){if(this.parent){this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=undefined;}}}
class FakeElement extends FakeNode{
 children:FakeNode[]=[];attributes=new Map<string,string>();listeners:{type:string;fn:()=>void;signal?:AbortSignal}[]=[];className='';id='';dataset:Record<string,string>={};[key:string]:unknown;
 constructor(public tagName:string,public ownerDocument:FakeDocument){super();}
 override get textContent():string{return this.children.map(c=>c.textContent).join('');}
 override set textContent(value:string){this.replaceChildren(new FakeNode(value));}
 get firstElementChild(){return this.children.find(c=>c instanceof FakeElement) as FakeElement|undefined;}
 setAttribute(name:string,value:string){this.attributes.set(name,String(value));}
 getAttribute(name:string){return this.attributes.get(name)??null;}
 removeAttribute(name:string){this.attributes.delete(name);}
 append(...nodes:(FakeNode|string)[]){for(const n of nodes){const node=typeof n==='string'?new FakeNode(n):n;node.remove();node.parent=this;this.children.push(node);}}
 prepend(...nodes:FakeNode[]){for(const n of nodes.reverse()){n.remove();n.parent=this;this.children.unshift(n);}}
 replaceChildren(...nodes:FakeNode[]){for(const c of this.children)c.parent=undefined;this.children=[];this.append(...nodes);}
 addEventListener(type:string,fn:()=>void,options?:{signal?:AbortSignal}){this.listeners.push({type,fn,signal:options?.signal});}
 focus(){}
 fire(type:string){for(const l of this.listeners)if(l.type===type&&!l.signal?.aborted)l.fn();}
 all():FakeElement[]{return this.children.flatMap(c=>c instanceof FakeElement?[c,...c.all()]:[]);}
 find(name:string){return this.all().find(e=>e.getAttribute('data-blocking')===name);}
}
class FakeDocument{createElement(tag:string){const e=new FakeElement(tag,this);if(tag==='input'){e.value='';e.checked=false;}return e;}createTextNode(text:string){return new FakeNode(text);}}
async function until(check:()=>boolean,label:string){const end=Date.now()+5000;while(!check()){if(Date.now()>end)assert.fail(`timeout: ${label}`);await new Promise(r=>setTimeout(r,5));}}
function mountEarned(client:AccountClient,adapter?:EarnedAdapter){
 const doc=new FakeDocument(),root=doc.createElement('main');(globalThis as unknown as {document:unknown}).document=doc;
 const errors:unknown[]=[],shell=new AbortController();
 const context={root,client,signal:shell.signal,onError:(e:unknown)=>errors.push(e)} as unknown as PortalContext;
 const dispose=createBlocking(context,{earnedAdapter:adapter});
 return {root,errors,dispose};
}

test('study -> leisure is off by default, honest at zero, and cannot spend without an owned adapter',async()=>{
 const s=await setup();
 try{
  const m=mountEarned(s.client);
  await until(()=>!!m.root.find('earned-toggle'),'earned card');
  assert.match(m.root.find('earned-toggle')!.textContent,/Turn on study/);
  assert.equal(m.root.find('earned-balance'),undefined,'no balance claim while the rule is off');
  assert.match(m.root.find('earned-rate')!.textContent,/1 second of leisure per second of learning \(1:1\)/);
  assert.match(m.root.find('earned-window')!.textContent,/24 hours/);assert.match(m.root.find('earned-size')!.textContent,/30s to 30m/);
  assert.match(m.root.find('earned-basis')!.textContent,/user-confirmed learning labels and observed recorded time, not verified learning/);
  assert.equal(((await s.client.request('/earned-leisure/read',{})) as {enabled:boolean}).enabled,false);
  m.root.find('earned-toggle')!.fire('click');
  await until(()=>!!m.root.find('earned-balance'),'balance after opt-in');
  assert.equal(m.root.find('earned-available')!.textContent,'0s');assert.match(m.root.find('earned-zero')!.textContent,/Nothing earned yet/);
  assert.equal(m.root.find('earned-redeem')!.disabled,true);assert.match(m.root.find('earned-instruction')!.textContent,/paired companion/);
  assert.equal(((await s.client.request('/earned-leisure/read',{})) as {enabled:boolean}).enabled,true);
  m.dispose();
 }finally{await s.close();}
});

test('redeem needs the adapter\'s owned device/host/policy, spends once, and says so when the pause was not applied',async()=>{
 const s=await setup(),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{
  await s.client.request('/processing',{local:true});await s.client.request('/earned-leisure/opt-in',{enabled:true});
  const start=now,key=await s.upload(observation(s.deviceId,start,90));now+=90000;
  const aiOnly=await s.client.request('/earned-leisure/read',{}) as {balance:{earnedSeconds:number}};assert.equal(aiOnly.balance.earnedSeconds,0,'unlabelled time earns nothing');
  await s.client.request('/corrections',{key,evidenceRevision:1,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}});
  const applied:EarnedLease[]=[];let succeed=true;
  const adapter:EarnedAdapter={target:()=>({deviceId:s.deviceId,host:'leisure.invalid',policyVersion:1}),async apply(lease){applied.push(lease);return succeed;}};
  const m=mountEarned(s.client,adapter);
  await until(()=>!!m.root.find('earned-seconds'),'redeem form');
  assert.equal(m.root.find('earned-available')!.textContent,'1m 30s');
  m.root.find('earned-seconds')!.value='30';m.root.find('earned-redeem')!.fire('click');
  await until(()=>!!m.root.find('earned-note')&&/applied/.test(m.root.find('earned-note')!.textContent),'applied');
  assert.equal(applied.length,1);assert.equal(applied[0]!.seconds,30);assert.equal(applied[0]!.host,'leisure.invalid');assert.equal(m.root.find('earned-available')!.textContent,'1m');
  succeed=false;m.root.find('earned-seconds')!.value='30';m.root.find('earned-redeem')!.fire('click');
  await until(()=>/was not applied/.test(m.root.find('earned-note')?.textContent??''),'honest not-applied');
  assert.equal(applied.length,2);assert.equal(m.root.find('earned-available')!.textContent,'30s','the deduction is stated, not hidden');
  m.root.find('earned-seconds')!.value='5';m.root.find('earned-redeem')!.fire('click');
  await until(()=>/Choose between/.test(m.root.find('earned-note')?.textContent??''),'range refusal');assert.equal(applied.length,2);
  m.dispose();
 }finally{Date.now=realNow;await s.close();}
});
