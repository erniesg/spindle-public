import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {portalHtml} from '../../core/account/portal/page.js';
import {driveFolderId} from '../../core/account/portal/connections.js';
import {chips,costLine,photoPair,type Prep} from '../../core/account/portal/prep.js';
import {look,inboxCard} from '../../core/account/portal/today.js';
import {UNCERTAIN_SEND} from '../../core/account/portal/review.js';
import {esc,sender} from '../../core/account/portal/ui.js';
import type {InboxItem} from '../../core/account/portal/context.js';

const source=(name:string)=>readFile(new URL('../../../core/account/portal/'+name+'.ts',import.meta.url),'utf8');
const views=['app','today','review','connections','settings','lock-in','attention','prep','ui'];

test('sign-in is one WorkOS button, bound to this origin, with no password form',async()=>{
 const app=await source('app');
 assert.match(app,/fetch\('\/auth\/workos\/config'/);assert.match(app,/config\.backendOrigin===location\.origin/);
 assert.match(app,/href="\/auth\/workos\/begin"/);assert.doesNotMatch(app,/type="password"|\/signin'|\/register'/);
 assert.match(app,/A little space for you\./);assert.match(app,/Welcome back\./);
});

test('consumer copy carries no operator, backend or test wording',async()=>{
 const text=[portalHtml,...await Promise.all(views.map(source))].join('\n');
 for(const phrase of [/Backend:/,/Direct service/,/Account names are not/,/Sync across devices/,/\boperator\b/i,/\bfixture\b/i,/consent id/i,/does not start recording/i,/Nothing was (?:sent|changed)/,/Jordan Lee/,/Morrow/])assert.doesNotMatch(text,phrase,String(phrase));
});

test('Send is only ever an explicit click: one /mail/send call site behind data-send',async()=>{
 const review=await source('review');
 assert.equal(review.split("'/mail/send'").length-1,1);
 assert.match(review,/hasAttribute\('data-send'\)\)\{void send\(\)/);
 assert.match(UNCERTAIN_SEND,/couldn’t confirm it was sent/);assert.match(UNCERTAIN_SEND,/Sent folder/);
 for(const name of views.filter(n=>n!=='review'))assert.doesNotMatch(await source(name),/\/mail\/send/,name);
});

test('Drive folder links resolve to a folder id; anything else is refused',()=>{
 assert.equal(driveFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing'),'1AbCdEfGhIjKlMnOpQrStUv');
 assert.equal(driveFolderId('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOpQrStUv'),'1AbCdEfGhIjKlMnOpQrStUv');
 assert.equal(driveFolderId('  1AbCdEfGhIjKlMnOpQrStUv '),'1AbCdEfGhIjKlMnOpQrStUv');
 for(const bad of ['https://evil.example/folders/1AbCdEfGhIjKlMnOpQrStUv','http://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv','not a link','https://drive.google.com/file/d/x'])assert.equal(driveFolderId(bad),undefined,bad);
});

test('tool chips prefer the ordered timeline, then the checklist, then the step map; cost is small and factual',()=>{
 const base={fields:[],artifacts:[],sources:[],checklist:{revision:1,reason:'',items:[]}} as unknown as Prep;
 assert.deepEqual(chips({...base,timeline:[{label:'Look up spec',status:'ok'},{label:'Remove background',status:'running'},{label:'Crop'}]}).map(c=>c.state),['done','running','pending']);
 assert.deepEqual(chips({...base,checklist:{revision:1,reason:'',items:[{id:'a',title:'Read passbook',state:'done',dependsOn:[]},{id:'b',title:'Skip',state:'skipped',dependsOn:[]}]}}),[{label:'Read passbook',state:'done'}]);
 assert.deepEqual(chips({...base,steps:{photo:{status:'ok',observedAt:'',origin:'runtime'}},execution:{state:'idle',phase:'',observedAt:''}}),[{label:'Prepare photo',state:'done'}]);
 assert.equal(costLine({...base,budget:{reservedUsd:0.123},timeline:[{label:'a',status:'ok'},{label:'b',status:'ok'}]}),'$0.12 · 2 steps');
 assert.equal(costLine(base),'');
 const pair=photoPair({...base,sources:[{id:'s',mimeType:'image/jpeg',snapshotArtifactId:'snap'}],artifacts:[{id:'snap',mimeType:'image/jpeg',sha256:'',bytes:1},{id:'out',mimeType:'image/jpeg',sha256:'',bytes:1,current:true}]} as unknown as Prep);
 assert.equal(pair.final?.id,'out');assert.equal(pair.original?.id,'snap');
});

test('inbox card states and escaping',()=>{
 const item:InboxItem={id:'m<1',threadId:'t',from:'"Harbour <Arts>" <hi@example.test>',subject:'<b>Hi</b>',receivedAt:'2026-10-30T08:00:00Z',summary:'',state:'draft_ready'};
 assert.equal(look(item).label,'Ready for review');assert.equal(look({...item,state:'detected'}).summary,'Spindle picked this up.');
 const html=inboxCard(item);assert.doesNotMatch(html,/<b>Hi<\/b>/);assert.match(html,/&lt;b&gt;Hi/);assert.match(html,/href="#review\/m%3C1"/);
 assert.equal(sender('Harbour Arts <hi@example.test>').name,'Harbour Arts');assert.equal(esc('"\''),'&quot;&#39;');
});

test('attention shows the classifier description as the block label, else activity/category/app',async()=>{
 const {blockLabel}=await import('../../core/account/portal/attention.js');
 assert.equal(blockLabel({description:'Researching visa requirements',categoryId:'work'},'Chrome'),'Researching visa requirements');
 assert.equal(blockLabel({description:null,categoryId:'work',activityId:null},'Chrome'),'Work');
 assert.equal(blockLabel({description:null,categoryId:'work',activityId:'code-review'},'Chrome'),'Code review');
 assert.equal(blockLabel(null,'Chrome'),'Chrome');
});
