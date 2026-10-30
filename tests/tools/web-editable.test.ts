import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {WebReader} from '../../core/tools/web.js';
import {BrowserPageInspector} from '../../core/tools/page-inspector.js';

test('production inspector excludes editable entry before reads in real Chromium',{skip:!process.env.SPINDLE_WEB_CHROMIUM},async t=>{
 let html='';const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/apply?revision=2`;
 const root=mkdtempSync(join(tmpdir(),'web-editable-'));const store=new EvidenceStore(root);let browser;
 try {
 browser=await chromium.launch({executablePath:process.env.SPINDLE_WEB_CHROMIUM,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();const ns={workspaceId:'w',accountId:'a'};
 const inspector=new BrowserPageInspector(store,new WebReader(store,{portal:url},[new URL(url).origin]));
 const load=async(body:string)=>{
 html=`<title>Invented requirements</title>${body}`;await page.goto(url);
 await page.evaluate(()=>{
 const original=CharacterData.prototype.substringData;let reads=0;
 Object.defineProperty(window,'entryReads',{get:()=>reads});
 CharacterData.prototype.substringData=function(offset,count){
 let parent=this.parentElement as Element|null;while(parent&&!(parent instanceof HTMLElement))parent=parent.parentElement;
 if(parent?.isContentEditable){reads++;throw Error('editable entry read before exclusion');}
 return original.call(this,offset,count);
 };
 });
 };
 const inspect=async()=>{
 const result=await inspector.inspect(page,'portal',ns);const bytes=store.read(ns,result.artifact.id);
 assert.doesNotMatch(JSON.stringify(result.observed),/INVENTED_ENTRY_59/);assert.doesNotMatch(bytes.toString(),/INVENTED_ENTRY_59/);
 assert.deepEqual(JSON.parse(bytes.toString()),result.observed);
 assert.equal(await page.evaluate(()=>Reflect.get(window,'entryReads') as number),0);return result.observed;
 };
 await t.test('directly typed editable text is not requirements',async()=>{
 await load('<p>Deadline Friday</p><div contenteditable="true" role="textbox"></div>');
 await page.getByRole('textbox').fill('INVENTED_ENTRY_59');
 assert.match((await inspect()).text,/Deadline Friday/);
 });
 await t.test('inherited and nested editable label/description text is excluded; readonly islands remain',async()=>{
 await load('<label for="photo">Portrait <span contenteditable="true"><b>INVENTED_ENTRY_59</b></span></label><div contenteditable="plaintext-only"><span id="hint"><b>INVENTED_ENTRY_59</b><svg><text>INVENTED_ENTRY_59</text></svg></span><div contenteditable="false"><span id="readonly">JPEG only</span> <span contenteditable="true">INVENTED_ENTRY_59</span></div></div><input id="photo" type="file" accept="image/jpeg" aria-describedby="hint readonly">');
 const result=await inspect();assert.equal(result.fields[0]?.label,'Portrait');assert.equal(result.fields[0]?.description,'JPEG only');
 assert.equal(result.fields[0]?.accept,'image/jpeg');assert.match(result.text,/JPEG only/);
 // A referenced helper root can inherit editability from outside its own walk.
 await load('<div contenteditable="true"><label for="photo"><b>INVENTED_ENTRY_59</b></label><span id="hint">INVENTED_ENTRY_59</span></div><input id="photo" aria-describedby="hint">');
 const inherited=await inspect();assert.equal(inherited.fields[0]?.label,'');assert.equal(inherited.fields[0]?.description,'');
 });
 await t.test('ordinary readonly requirements labels and metadata remain',async()=>{
 await load('<p>Deadline Friday</p><label for="photo">Portrait</label><span id="hint">JPEG only</span><input id="photo" type="file" required accept="image/jpeg" aria-describedby="hint">');
 const result=await inspect();assert.match(result.text,/Deadline Friday/);assert.equal(result.fields[0]?.label,'Portrait');
 assert.equal(result.fields[0]?.description,'JPEG only');assert.equal(result.fields[0]?.required,true);assert.equal(result.fields[0]?.accept,'image/jpeg');
 });
 await t.test('editable descendants still require operator for hidden password',async()=>{
 await load('<div contenteditable="true"><b>INVENTED_ENTRY_59</b><input type="password" hidden></div>');
 const before=readdirSync(join(root,'artifacts'));await assert.rejects(inspector.inspect(page,'portal',ns),/Authentication.*operator/);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);assert.equal(await page.evaluate(()=>Reflect.get(window,'entryReads') as number),0);
 });
 await t.test('large ignored entry is never read; ignored descendants still exhaust traversal without persistence',async()=>{
 await load(`<div contenteditable="true">${'INVENTED_ENTRY_59'.repeat(10000)}</div><p>Deadline Friday</p>`);
 assert.match((await inspect()).text,/Deadline Friday/);
 await load(`<div contenteditable="true">${'<span>INVENTED_ENTRY_59</span>'.repeat(11000)}<input type="password"></div>`);
 const before=readdirSync(join(root,'artifacts'));await assert.rejects(inspector.inspect(page,'portal',ns),/Incomplete.*budget/);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);assert.equal(await page.evaluate(()=>Reflect.get(window,'entryReads') as number),0);
 });
 }finally{await browser?.close();store.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(root,{recursive:true,force:true});}
});
