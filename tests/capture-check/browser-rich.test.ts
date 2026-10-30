import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewSession } from '../../core/preview/session.js';
import { CaptureClassification } from '../../core/preview/classification.js';
import { Vault } from '../../core/preview/vault.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII=';
function setup(rich=true){
 const session=new PreviewSession();
 session.start({pixels:true,rich,retain:true});
 session.focus({epoch:session.epoch,revision:1,at:0,key:'chrome-window',app:'com.google.Chrome',title:'',clock:'native',browser:true});
 session.browser({challenge:session.challenge(),private:false,focused:true,document:'doc-a:0',url:'https://invented.example',title:'Invented article',text:'Visible article'});
 const event={challenge:session.challenge(),private:false,focused:true,document:'doc-a:0',url:'https://invented.example',image:png,gesture:true};
 return {session,event};
}

test('automatic Rich images remain admitted by the existing local classifier/correction consumer',()=>{
 const {session,event}=setup(),classification=new CaptureClassification(session);classification.local(true);
 try{
  assert.equal(session.browserImage({...event,gesture:false,automatic:true},1),true);
  const id=session.active!.id,ref=classification.inspect(id).ref;
  classification.correct(id,{categoryId:'learning',activityId:'reading',relatedIds:[]},ref);
  assert.equal(classification.inspect(id).source,'override');
  assert.equal(session.browserImage({...event,gesture:false,automatic:true},2),true);assert.equal(classification.inspect(id).source,'override','identical automatic image does not erase exact correction');
  session.revokeBrowser();assert.throws(()=>classification.inspect(id),/CONTEXT_UNAVAILABLE/);
 }finally{classification.dispose();}
});
test('a separately authorized Chrome image round-trips through the real encrypted store on its matching visit',async t=>{
 const {session,event}=setup();const id=session.active!.id;
 assert.equal(session.browserImage(event,0),true);
 assert.equal(session.active!.id,id);assert.equal(session.active!.image,png);
 const directory=await mkdtemp(join(tmpdir(),'spindle-browser-rich-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const vault=new Vault(directory),key=Buffer.alloc(32,11);
 await vault.write(session.snapshot(),key,1000,()=>true);
 const saved=await vault.read(key) as {visits:{id:string;image:string}[]};
 assert.deepEqual(saved.visits.map(v=>[v.id,v.image]),[[id,png]]);
 assert.ok(!(await readFile(join(directory,'context.enc'))).includes(Buffer.from(png)));
 await vault.clear();assert.equal(await vault.read(key),null);
});

test('browser images deny Default, missing scopes, invalid PNG, unknown/private state and wrong document/origin',()=>{
 const {session,event}=setup(false);assert.equal(session.browserImage(event,0),false);
 session.options.rich=true;
 for(const patch of [{gesture:false},{private:true},{private:undefined},{focused:false},{document:'doc-b:0'},{url:'https://other.example'},{image:'AAAA'},{image:'A'.repeat(2_800_001)}])assert.equal(session.browserImage({...event,...patch},0),false);
 for(const scope of ['pixels','retain'] as const){session.options[scope]=false;assert.equal(session.browserImage(event,0),false);session.options[scope]=true;}
 assert.equal(session.active!.image,'');
});

test('automatic browser images preserve path scope and reject stale consent',()=>{
 const {session,event}=setup();
 const challenge=session.challenge();
 assert.equal(session.browser({...event,challenge,url:'https://invented.example/projects/draft',title:'Draft',text:'Visible heading'},100),true);
 assert.equal(session.active!.sampledAt,100,'new browser visit has its own context timestamp');
 const automatic={...event,challenge:session.challenge(),url:'https://invented.example/projects/draft',gesture:false,automatic:true};
 assert.equal(session.browserImage(automatic,101),true);
 assert.equal(session.active!.url,automatic.url);
 assert.equal(session.active!.availability,'browser-automatic-rich-partial');
 for(const url of ['https://invented.example/p?q=secret','https://invented.example/p#secret','https://user:pass@invented.example/p'])assert.equal(session.browser({...automatic,url,title:'x',text:'x'}),false);
 session.pause(101);assert.equal(session.browserImage(automatic,102),false);
});

test('browser image receipt must follow its admitted context without relabelling stale pixels',()=>{
 const {session,event}=setup();
 assert.ok(session.browser({...event,url:'https://invented.example/new',title:'New',text:'New'},100));
 const current={...event,challenge:session.challenge(),url:session.active!.url};
 assert.equal(session.browserImage(current,99),false,'receipt before the new visit is not current');
 assert.equal(session.browserImage(current,100),true,'explicit source-domain receipt admits the fresh image');
 assert.equal(session.active!.imageSampledAt,100);
 assert.ok(session.browser({...current,title:'Changed',text:'Changed',challenge:session.challenge()},200));
 const changed={...current,challenge:session.challenge()};
 assert.equal(session.browserImage(changed,150),false,'do not clamp an image older than current text');
 assert.equal(session.active!.image,'');
 assert.equal(session.browserImage(changed,201),true);
 assert.equal(session.active!.imageSampledAt,201);
});

test('manual browser images cannot resurrect after navigation, pause, Clear or profile revocation',()=>{
 for(const action of ['navigate','pause','clear','revoke'] as const){
  const {session,event}=setup();
  if(action==='navigate')session.browser({...event,document:'doc-b:0',title:'B',text:'B'},1);
  if(action==='pause')session.pause(1);
  if(action==='clear')session.clear();
  if(action==='revoke')session.revokeBrowser();
  assert.equal(session.browserImage(event,2),false,action);
  assert.ok(session.visits.every(v=>!v.image),action);
 }
});
