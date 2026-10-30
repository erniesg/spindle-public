import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewSession } from '../../core/preview/session.js';
import { Vault } from '../../core/preview/vault.js';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { FixtureOwner } from '../../core/preview/fixture.js';

test('same-window native titles refresh with their fenced sample, never from late work',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});
 s.focus({epoch:s.epoch,revision:1,at:10,key:'window',app:'photos',title:'Photos',clock:'native'});
 const id=s.visits[0].id;
 s.sample({epoch:s.epoch,revision:1,at:20,title:'Invented A.png',text:'A',image:'AAAA'});
 assert.equal(s.visits[0].title,'Invented A.png');
 s.sample({epoch:s.epoch,revision:1,at:30,title:'Invented B.png',text:'B',image:'BBBB'});
 assert.equal(s.visits[0].title,'Invented B.png');assert.equal(s.visits[0].id,id);
 s.sample({epoch:s.epoch,revision:1,at:25,title:'STALE',text:'OLD'});
 assert.equal(s.visits[0].title,'Invented B.png');
 s.pause(40);s.sample({epoch:s.epoch,revision:1,at:50,title:'AFTER PAUSE'});
 assert.equal(s.visits[0].title,'Invented B.png');
});

test('native acquisition, OCR and retained-image outcomes survive snapshot without conflating them',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});
 s.focus({epoch:s.epoch,revision:1,at:10,key:'window',app:'photos',title:'A',clock:'native'});
 const capture={pixels:'captured',ocr:'ocr-language-unavailable',image:'image-retained',sourceWidth:3840,sourceHeight:2160,imageWidth:3840,imageHeight:2160,ocrWidth:2666,ocrHeight:1500};
 s.sample({epoch:s.epoch,revision:1,at:20,image:'AAAA',status:'ocr-language-unavailable',capture});
 const visit=s.snapshot().visits[0];
 assert.deepEqual((visit as unknown as {capture:unknown}).capture,capture);
 assert.equal(visit.image,'AAAA');assert.equal(visit.availability,'ocr-language-unavailable');
});

test('Clear/reopen then delayed old exit or error cannot orphan the newer fixture on Quit',()=>{
 for(const event of ['exit','error']){
  const children:{events:EventEmitter;killed:number}[]=[];let failures=0;
  const owner=new FixtureOwner(()=>{
   const child={events:new EventEmitter(),killed:0};children.push(child);
   return Object.assign(child.events,{kill:()=>{child.killed++;return true;}}) as unknown as ChildProcess;
  },()=>{failures++;});
  owner.open();owner.open();assert.equal(children.length,1);
  owner.stop();owner.open();assert.equal(children.length,2);
  children[0].events.emit(event,event==='error'?new Error('invented late failure'):0);
  owner.open();assert.equal(children.length,2,'old callback must not erase current ownership');
  owner.stop();assert.equal(children[1].killed,1,'Quit must terminate the replacement child');
  assert.equal(failures,0,'old failures must not alter current state');
  owner.open();children[2].events.emit('error',new Error('invented current failure'));
  assert.equal(failures,1);owner.open();assert.equal(children.length,4);owner.stop();
 }
});

test('replacement fixture really exits after Clear/reopen and Quit ownership cleanup',{timeout:5000},async t=>{
 const children:ChildProcess[]=[],exits:Promise<unknown>[]=[];
 t.after(()=>{for(const child of children)if(child.exitCode===null&&!child.killed)child.kill();});
 const owner=new FixtureOwner(()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  children.push(child);exits.push(once(child,'exit'));return child;
 },()=>assert.fail('invented child must launch'));
 owner.open();await once(children[0],'spawn');owner.stop();owner.open();
 await once(children[1],'spawn');await exits[0];owner.open();
 assert.equal(children.length,2,'delayed real exit must preserve the second child');
 owner.stop();await exits[1];assert.notEqual(children[1].signalCode,null);
});

test('gap cutoff removes active-visit context sampled after the cutoff, not earlier valid context',()=>{
 for(const sampledAt of [1200,2000]){
  const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});s.focus({epoch:s.epoch,revision:1,at:1000,key:'invented-window',app:'spindlefixture',title:'Invented gap sample',clock:'invented'});
  s.sample({epoch:s.epoch,revision:1,at:sampledAt,title:'INVENTED SAMPLE TITLE',text:'INVENTED CONTEXT',image:'AAAA',status:'native-text'});s.gap(1500);
  assert.equal(s.recording,false);assert.equal(s.visits[0].end,1500);
  assert.equal(s.visits[0].text,sampledAt>=1500?'':'INVENTED CONTEXT');assert.equal(s.visits[0].image,sampledAt>=1500?'':'AAAA');
  assert.equal(s.visits[0].title,sampledAt>=1500?'':'INVENTED SAMPLE TITLE');
 }
});

test('retained-image eviction updates the disclosed outcome and dimensions',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:true,retain:true});
 const capture={pixels:'captured',ocr:'local-ocr',image:'image-retained',sourceWidth:3840,sourceHeight:2160,imageWidth:3840,imageHeight:2160,ocrWidth:2666,ocrHeight:1500};
 for(let revision=1;revision<=3;revision++){
  s.focus({epoch:s.epoch,revision,at:revision*10,key:'window-'+revision,app:'photos',title:'Invented',clock:'native'});
  s.sample({epoch:s.epoch,revision,at:revision*10+1,image:'A'.repeat(2800000),capture});
 }
 assert.equal(s.visits[0].image,'');assert.equal(s.visits[0].capture?.image,'image-evicted');assert.equal(s.visits[0].capture?.imageWidth,0);
 assert.equal(s.visits[2].capture?.image,'image-retained');
});

test('preview conserves native returns and fences pause/delete/late images; browser detail has no native fallback', () => {
  const s = new PreviewSession(); s.start({ pixels: true, rich: true, retain: true });
  for (const [at,key] of [[0,'A'],[2000,'B'],[5000,'A'],[6000,'B']] as const) s.focus({ kind:'focus',epoch:s.epoch,revision:s.visits.length+1,at,key,title:key,app:'sample',clock:'native-clock' });
  s.pause(10000); assert.deepEqual(s.visits.map(v => (v.end ?? 0)-v.start),[2000,3000,1000,4000]);
  assert.equal(s.sample({kind:'sample',epoch:s.epoch,revision:4,at:6500,text:'LATE',image:'AAAA'}),false);
  s.clear(); assert.equal(s.visits.length,0);
  s.start({pixels:false,rich:false,retain:false}); s.focus({kind:'focus',epoch:s.epoch,revision:1,at:0,key:'browser',app:'com.google.Chrome',title:'MUST NOT SURVIVE',clock:'native-clock',browser:true});
  assert.equal(s.visits[0].title,''); assert.equal(s.sample({kind:'sample',epoch:s.epoch,revision:1,at:1,text:'BYPASS'}),false);
});
test('browser challenges reject unknown/private state, raw URLs, navigation races and pause/clear replays',()=>{
 const s=new PreviewSession();s.start({pixels:false,rich:false,retain:false});s.focus({kind:'focus',epoch:s.epoch,revision:1,at:10,key:'chrome-window',app:'com.google.Chrome',title:'',clock:'native',browser:true});
 const first={challenge:s.challenge(),private:false,focused:true,document:'doc-a',url:'https://sample.example',title:'Invented A',text:'DOM A'};
 assert.equal(s.browser({...first,private:true},20),false);assert.equal(s.browser({...first,private:undefined},20),false);assert.equal(s.browser({...first,url:'https://user:secret@sample.example/path?secret#fragment'},20),false);
 assert.equal(s.browser(first,20),true);assert.equal(s.browser({...first,challenge:s.challenge(),document:'doc-b',title:'Invented B'},30),true);assert.equal(s.visits.length,2);
 assert.equal(s.browser(first,40),false); // Old visit challenge cannot enrich the new document visit.
 const next={...first,challenge:s.challenge(),document:'doc-a'};assert.equal(s.browser(next,40),true);assert.equal(s.visits.length,3);
 s.pause(50);assert.equal(s.browser(next,60),false);s.clear();assert.equal(s.visits.length,0);
});
test('profile revocation erases browser context and fences an admitted result',()=>{
 const s=new PreviewSession();s.start({pixels:false,rich:false,retain:false});s.focus({kind:'focus',epoch:s.epoch,revision:1,at:0,key:'chrome',app:'com.google.Chrome',title:'',clock:'native',browser:true});
 const value={challenge:s.challenge(),private:false,focused:true,document:'doc',url:'https://sample.example',title:'Invented',text:'REMOVE_ON_REVOKE'};
 assert.equal(s.browser(value),true);s.revokeBrowser();assert.equal(s.browser(value),false);assert.equal(s.visits[0].text,'');assert.equal(s.visits[0].url,'');assert.equal(s.visits[0].availability,'profile-revoked');
});
test('Default never retains injected images; same-visit out-of-order text cannot replace newer content',()=>{
 const s=new PreviewSession();s.start({pixels:true,rich:false,retain:true});s.focus({kind:'focus',epoch:s.epoch,revision:1,at:0,key:'A',title:'A',app:'sample',clock:'native'});
 assert.equal(s.sample({epoch:s.epoch,revision:1,at:20,text:'NEW',image:'AAAA'}),true);assert.equal(s.visits[0].image,'');assert.equal(s.sample({epoch:s.epoch,revision:1,at:10,text:'OLD'}),false);assert.equal(s.visits[0].text,'NEW');
});
test('real encrypted file boundary: key denial, readback, expiry, clear and no plaintext temporary files', async t => {
  const dir=await mkdtemp(join(tmpdir(),'spindle-preview-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key=Buffer.alloc(32,7); let now=1000; const v=new Vault(dir,()=>now);
  await assert.rejects(v.read(null),/KEY_UNAVAILABLE/);
  await v.write({text:'INVENTED_SECRET',image:'INVENTED_PIXELS'},key,1000,()=>true);
  assert.deepEqual(await v.read(key),{text:'INVENTED_SECRET',image:'INVENTED_PIXELS'});
  for (const file of await readdir(dir)) assert.ok(!(await readFile(join(dir,file))).includes(Buffer.from('INVENTED_SECRET')));
  await assert.rejects(v.read(Buffer.alloc(32,8)),/STORE_UNREADABLE/);
  now=2001; assert.equal(await v.read(key),null); assert.deepEqual(await readdir(dir),[]);
  await v.write({text:'DO_NOT_COMMIT'},key,1000,()=>false); assert.deepEqual(await readdir(dir),[]);
  await v.write({text:'DELETE'},key,1000,()=>true); await v.clear(); assert.deepEqual(await readdir(dir),[]);
});
