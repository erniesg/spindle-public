// Backend/browser boundary proof, NOT presentation UI or native OS acceptance.
// Invented device observations are uploaded by real authenticated clients; only
// the empty viewer document is fulfilled by the test, never an API response.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import type {HistoryRecord,Operation} from '../../core/tracking/types.js';
import type {SessionReport} from '../../core/tracking/session.js';

const dir=await mkdtemp(resolve('.local/web-viewer-')),key=randomBytes(32);
let server=await startTrackingServer(join(dir,'server'),key);
const origin=server.origin,now=Date.now(),password='invented-browser-password';
const browser=await chromium.launch({executablePath:process.env.SPINDLE_CHROMIUM_EXECUTABLE,headless:true});
const context=await browser.newContext();
await context.route(origin+'/viewer',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Invented API viewer fixture</title>'}));
const page=await context.newPage();
const call=(path:string,body?:unknown,csrf?:string)=>page.evaluate(async({path,body,csrf})=>{
 const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
},{path,body,csrf});
const from=now,to=now+90000;
const report=async(deviceId?:string)=>{const r=await call(`/sessions?from=${from}&to=${to}`+(deviceId?'&deviceId='+deviceId:''));assert.equal(r.status,200);return r.data as SessionReport;};
function observation(deviceId:string,start:number,end:number):Operation{
 const visitId=randomUUID();
 const record:HistoryRecord={schema:'spindle-tracking/v1',deviceId,recordingId:'invented-recording',visitId,revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:end,expiresAt:now+3600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:end,coverage:'observed'},visit:{id:visitId,key:'invented-process/window',app:'invented-editor',title:'Invented work',start,end,clock:'invented-source-clock',revision:1,browser:false,text:'function invented() {}',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:start,framePTS:null,expiresAt:now+900000}};
 return {id:randomUUID(),deviceId,recordingId:record.recordingId,visitId,record};
}
try{
 const a=new TrackingClient(origin,join(dir,'a'),randomBytes(32)),b=new TrackingClient(origin,join(dir,'b'),randomBytes(32));
 await a.signin('web-account',password,'Invented Mac',true);await b.signin('web-account',password,'Invented Windows');
 const aId=(await a.inspect()).deviceId,bId=(await b.inspect()).deviceId;
 const first=observation(aId,0,60000),second=observation(bId,30000,90000);
 await a.enqueue(first);await a.sync();await b.enqueue(second);await b.sync();
 // Fill all collector slots: viewing must neither require nor create a device.
 for(let i=2;i<16;i++){const c=new TrackingClient(origin,join(dir,'slot'+i),randomBytes(32));await c.signin('web-account',password,'Invented slot '+i);}
 await page.goto(origin+'/viewer');
 const signed=await call('/signin',{name:'web-account',password});assert.equal(signed.status,200);
 let csrf=signed.data.csrf as string;
 await context.addCookies([{name:'invented_ui_preference',value:'sample',url:origin}]);
 let readHadOrigin=false;page.on('request',r=>{if(new URL(r.url()).pathname==='/history')readHadOrigin||=r.headers().origin!==undefined;});
 const session=await call('/session');assert.equal(session.status,200);assert.equal(session.data.deviceId,null);
 const devices=await call('/devices');assert.equal(devices.status,200);assert.equal(devices.data.devices.length,16);
 assert.ok(devices.data.devices.find((d:{id:string;lastUploadAt:number|null})=>d.id===aId&&typeof d.lastUploadAt==='number'));
 const history=await call('/history');assert.equal(history.status,200);assert.equal(history.data.entries.length,2);assert.equal(readHadOrigin,false,'real same-origin browser GET supplies no Origin');
 assert.equal((await report()).personTime,90000);assert.equal((await report(aId)).personTime,60000);assert.equal((await report(bId)).personTime,60000);
 assert.equal((await call('/history?deviceId='+aId)).data.entries.length,1);
 assert.equal((await call('/sync',{operations:[observation(aId,0,1000)]},csrf)).status,403,'viewer cannot impersonate a collector');
 assert.equal((await call('/processing',{local:true})).status,403,'viewer mutations still require CSRF');
 const foreign=new URL(origin);foreign.port=String(Number(foreign.port)===65535?65534:Number(foreign.port)+1);
 await context.route(foreign.origin+'/adversary',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
 const adversary=await context.newPage();await adversary.goto(foreign.origin+'/adversary');
 assert.equal(await adversary.evaluate(async origin=>{try{await fetch(origin+'/history',{credentials:'include'});return 'read';}catch{return 'blocked';}},origin),'blocked','same-site foreign origin cannot read the authenticated response');await adversary.close();
 assert.equal((await call('/sessions?from='+from+'&to='+to+'&deviceId=foreign')).status,404);
 await page.reload();csrf=(await call('/session')).data.csrf;assert.equal((await report()).visits.length,2,'already uploaded data does not need its source device online');
 assert.equal((await call('/processing',{local:true},csrf)).status,200);
 const selected=(await report()).visits.find(v=>v.deviceId===aId)!;
 assert.equal((await call('/corrections',{key:selected.key,evidenceRevision:selected.evidenceRevision,expectedRevision:0,labels:{categoryId:'learning',activityId:'reading',relatedIds:[]}},csrf)).status,200);
 await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
 await page.reload();csrf=(await call('/session')).data.csrf;assert.equal((await report()).visits.find(v=>v.deviceId===aId)!.label?.source,'override');
 const peer=await browser.newContext();await peer.route(origin+'/viewer',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));const peerPage=await peer.newPage();await peerPage.goto(origin+'/viewer');
 await peerPage.evaluate(async password=>{const r=await fetch('/signin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'web-account',password})});if(!r.ok)throw Error('signin');},password);
 assert.equal(await peerPage.evaluate(async({from,to})=>(await(await fetch(`/sessions?from=${from}&to=${to}`)).json()).visits.length,{from,to}),2);
 assert.equal((await call('/sync',{operations:[{id:randomUUID(),deviceId:aId,recordingId:first.recordingId,visitId:first.visitId,delete:true}]},csrf)).status,200);
 await a.enqueue({...first,id:randomUUID()});await a.sync();
 assert.equal((await report()).visits.length,1);assert.equal((await call('/history')).data.entries.find((e:{visitId:string})=>e.visitId===first.visitId).deleted,true);
 assert.equal((await call('/logout',{},csrf)).status,200);assert.equal((await call('/history')).status,401);
 assert.equal((await call('/register',{name:'other-web-account',password})).status,200);csrf=(await call('/session')).data.csrf;
 assert.equal((await report()).visits.length,0);
 assert.equal((await call('/corrections',{key:selected.key,evidenceRevision:1,expectedRevision:0,labels:{categoryId:'work',activityId:'coding',relatedIds:[]}},csrf)).status,404);
 assert.equal((await call('/sync',{operations:[{id:randomUUID(),deviceId:bId,recordingId:second.recordingId,visitId:second.visitId,delete:true}]},csrf)).status,403);
 await peer.close();
 console.log('PASS actual browser cookie signin, Origin-free reads without collector enrollment at full device capacity, two invented-device uploads, all/filter overlap queries, offline-source reload, persistent correction/server restart, deletion replay, signout and account isolation. Empty test document only; no presentation/native acceptance.');
}finally{await context.close();await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
