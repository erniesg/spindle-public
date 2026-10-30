// One REAL account server, encrypted collector queues and Chromium timer/history
// clients. Invented native/browser source messages: Linux simulation, NOT native
// Mac/Windows cross-host, permission, screenshots or installed acceptance.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,type Page} from 'playwright-core';
import {startTrackingServer} from '../../core/tracking/server.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {PreviewSession} from '../../core/preview/session.js';
import {PreviewSettingsStore} from '../../core/preview/settings.js';
import {reopenTracking} from '../../core/preview/tracking-setup.js';
import {AccountClient} from '../../core/account/client.js';
import type {SessionReport} from '../../core/tracking/session.js';
import type {Snapshot} from '../../core/pomodoro/protocol.js';
await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/combined-sync-')),serverKey=randomBytes(32);
let server=await startTrackingServer(join(dir,'server'),serverKey);const origin=server.origin,port=Number(new URL(origin).port),from=Date.now()-1000;
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM??'/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
const password='invented-password-123',account='invented-combined',errors:string[]=[];
async function peer(name:string,register=false){
 const key=randomBytes(32),path=join(dir,name),setup={origin,name:account,deviceName:name};
 let client=new TrackingClient(origin,join(path,'account'),key);await client.signin(account,password,name,register);
 await new PreviewSettingsStore(join(path,'settings')).write({schema:'spindle-preview-settings/v1',profileToken:null,preferences:null,tracking:setup},key);
 return {name,key,path,client,async restart(){await client.settle();const saved=await new PreviewSettingsStore(join(path,'settings')).read(key);client=await reopenTracking(saved.tracking!,join(path,'account'),key);this.client=client;}};
}
async function collect(client:TrackingClient,clock:string){
 const owner=new PreviewSession(),id=(await client.inspect()).deviceId,sink=new CollectorHistory(owner,client,id,3600000);
 try{
  owner.start({pixels:false,rich:false,retain:true});
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:0,coverage:'observed'});await sink.settle();
  assert.equal(owner.focus({epoch:owner.epoch,at:0,revision:1,key:'invented/editor',app:'Invented Editor',title:'Invented app visit',clock}),true);await sink.settle();
  assert.equal(owner.sample({epoch:owner.epoch,at:10,revision:1,text:'Invented editing text',textSource:'native',status:'native-text'}),true);await sink.settle();
  assert.equal(owner.focus({epoch:owner.epoch,at:1000,revision:2,key:'invented/browser',app:'Browser',title:'',browser:true,clock}),true);await sink.settle();
  assert.equal(owner.browser({challenge:owner.challenge(),private:false,focused:true,document:'invented-document',url:'https://example.com',title:'Invented browser visit',text:'Invented allowed DOM'},1100),true);await sink.settle();
  sink.evidence({awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:3000,coverage:'observed'});await sink.settle();
  owner.pause(3000);await sink.settle();assert.equal(owner.recording,false);
 }finally{await sink.dispose();}
}
async function drain(client:TrackingClient){for(let i=0;i<20;i++){const s=await client.sync();if(!s.pending&&!s.hasMore)return;}throw Error('SYNC_NOT_DRAINED');}
async function open(name=account,register=false){
 const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/pomodoro/app/');
 await page.locator('[name=account]').fill(name);await page.locator('[name=password]').fill(password);if(register)await page.locator('[name=register]').check();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.connection')?.getAttribute('data-state')==='online');return page;
}
async function report(page:Page){return page.evaluate(async({from})=>{const r=await fetch(`/sessions?from=${from}&to=${from+60000}`);if(!r.ok)throw Error(String(r.status));return r.json();},{from}) as Promise<SessionReport>;}
try{
 const mac=await peer('Mac invented (simulated)',true),win=await peer('Windows invented (simulated)'),ids=[(await mac.client.inspect()).deviceId,(await win.client.inspect()).deviceId];assert.notEqual(ids[0],ids[1]);
 // Independent producers use their OWN authenticated device registrations, source
 // clocks, production visit owner and collector queue. No injected account IDs.
 await Promise.all([collect(mac.client,'mac-simulated-boot'),collect(win.client,'windows-simulated-boot')]);
 assert.equal((await mac.client.inspect()).pending,2);assert.equal((await win.client.inspect()).pending,2);
 await drain(mac.client);await drain(win.client);
 const a=await open(),b=await open();let shared=await report(a);
 assert.equal(shared.visits.length,4);assert.deepEqual(Object.keys(shared.perDevice).sort(),ids.slice().sort());
 assert.deepEqual(shared.visits.map(v=>v.duration).sort((a,b)=>a-b),[1000,1000,2000,2000]);
 assert.deepEqual(Object.values(shared.perDevice),[3000,3000]);assert.ok(shared.blocks.some(block=>block.ambiguous),'overlap stays visible');assert.ok(shared.personTime<6000);
 assert.equal(shared.visits.filter(v=>v.context.text==='Invented allowed DOM').length,2);
 assert.deepEqual((await report(b)).visits.map(v=>v.key).sort(),shared.visits.map(v=>v.key).sort());
 assert.equal(new Set(shared.visits.map(v=>v.clock.source)).size,2);
 await a.locator('.focus-duration').fill('5');await a.getByRole('button',{name:'Start focus',exact:true}).click();await b.getByRole('button',{name:'Pause',exact:true}).waitFor();await b.getByRole('button',{name:'Pause',exact:true}).click();await a.getByRole('button',{name:'Resume',exact:true}).waitFor();
 const observer=new AccountClient(origin);await observer.signin(account,password);const paused=await observer.request('/pomodoro') as Snapshot;assert.equal(paused.timer.status,'paused');
 await a.getByRole('button',{name:'Resume',exact:true}).click();await b.getByRole('button',{name:'Pause',exact:true}).waitFor();const running=await observer.request('/pomodoro') as Snapshot;assert.equal(running.timer.status,'running');assert.equal(running.timer.revision,paused.timer.revision+1);
 // Offline producer keeps new history durable; reopens without signin or another
 // device registration. Same server/data/key/port restart also retains timer.
 await server.close();await collect(win.client,'windows-simulated-restart');await assert.rejects(win.client.sync());assert.equal((await win.client.inspect()).pending,2);
 await win.restart();assert.equal((await win.client.inspect()).deviceId,ids[1]);assert.equal((await win.client.inspect()).pending,2);
 await assert.rejects(win.client.signin('invented-isolated',password,'Other'),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);assert.equal((await win.client.inspect()).pending,2);
 server=await startTrackingServer(join(dir,'server'),serverKey,port);await drain(win.client);await mac.restart();await drain(mac.client);
 assert.deepEqual((await observer.request('/pomodoro') as Snapshot).timer,running.timer);
 await b.reload();await b.getByRole('button',{name:'Pause',exact:true}).waitFor();await b.getByRole('button',{name:'Pause',exact:true}).click();await a.getByRole('button',{name:'Resume',exact:true}).waitFor();await b.getByRole('button',{name:'Resume',exact:true}).click();await a.getByRole('button',{name:'Pause',exact:true}).waitFor();
 assert.equal((await observer.request('/pomodoro') as Snapshot).timer.revision,running.timer.revision+2);
 shared=await report(a);assert.equal(shared.visits.length,6);assert.equal(((await mac.client.devices()).devices as unknown[]).length,2);
 const foreign=await open('invented-isolated',true);assert.equal((await report(foreign)).visits.length,0);assert.match(await foreign.locator('.revision').innerText(),/revision 0/);
 assert.equal(await foreign.evaluate(async id=>(await fetch('/history?deviceId='+id)).status,ids[0]!),404);
 await assert.rejects(win.client.signin('invented-isolated',password,'Other'),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);
 assert.equal((await win.client.inspect()).pending,0);assert.equal((await report(a)).visits.length,6);
 await a.reload();await a.getByRole('button',{name:'Pause',exact:true}).waitFor();assert.equal((await report(a)).visits.length,6);
 await a.getByRole('button',{name:'Sign out',exact:true}).click();await a.locator('[name=account]').fill('invented-isolated');await a.locator('[name=password]').fill(password);await a.getByRole('button',{name:'Sign in',exact:true}).click();await a.waitForFunction(()=>document.querySelector('.account')?.textContent==='Signed in as invented-isolated');
 assert.equal((await report(a)).visits.length,0);assert.equal((await mac.client.sessions(from,from+60000)).visits.length,6);assert.deepEqual(errors,[]);
 console.log('PASS one real server: two registered simulated native/browser collectors + encrypted queues, same-account Chromium history and timer convergence, visible overlap/provenance, offline queue + client/server restart, stable devices and other-account isolation. NOT native cross-host/installed/deployment/UI acceptance.');
}finally{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
