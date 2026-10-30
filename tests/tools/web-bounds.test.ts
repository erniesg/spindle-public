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

test('production inspector bounds in real Chromium',{skip:!process.env.SPINDLE_WEB_CHROMIUM},async t=>{
 let html='';
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/apply?revision=2`;
 const root=mkdtempSync(join(tmpdir(),'web-bounds-'));const store=new EvidenceStore(root);
 let browser;
 try {
 browser=await chromium.launch({executablePath:process.env.SPINDLE_WEB_CHROMIUM,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();const ns={workspaceId:'w',accountId:'a'};
 const inspector=new BrowserPageInspector(store,new WebReader(store,{portal:url},[new URL(url).origin]));
 const load=async(body:string)=>{html=`<title>Invented requirements</title>${body}`;await page.goto(url);};
 const rejected=async(body:string,pattern=/[Bb]udget|[Ll]imit|[Ii]ncomplete|[Oo]versized/)=>{
 await load(body);const before=readdirSync(join(root,'artifacts'));
 await assert.rejects(inspector.inspect(page,'portal',ns),pattern);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before,'failed scan must not persist partial requirements');
 };
 await t.test('pilot ordinary exact provenance and useful labels without eager DOM getters',async()=>{
 await load('<p>Deadline Friday. White background.</p><label for="photo">Portrait</label><span id="hint">JPEG only</span><input id="photo" name="photo" type="file" required accept="image/jpeg" aria-describedby="hint"><label>Country<select name="country"><option value="sg">Singapore</option></select></label>');
 await page.evaluate(()=>{
 Object.defineProperty(HTMLElement.prototype,'innerText',{get(){throw Error('eager innerText forbidden');}});
 Object.defineProperty(Node.prototype,'textContent',{get(){throw Error('eager textContent forbidden');}});
 document.querySelectorAll=()=>{throw Error('eager querySelectorAll forbidden');};
 });
 const result=await inspector.inspect(page,'portal',ns);
 assert.equal(result.observed.url,url);assert.equal(result.source!.originalUrl,url);
 assert.match(result.observed.text,/Deadline Friday/);assert.equal(result.observed.title,'Invented requirements');
 assert.equal(result.observed.fields[0]?.label,'Portrait');assert.equal(result.observed.fields[0]?.description,'JPEG only');
 assert.equal(result.observed.fields[0]?.required,true);assert.equal(result.observed.fields[0]?.accept,'image/jpeg');
 assert.deepEqual(result.observed.fields[1]?.options,[{value:'sg',label:'Singapore'}]);
 assert.deepEqual(JSON.parse(store.read(ns,result.artifact.id).toString()),result.observed);
 assert.ok(result.artifact.bytes<=512000);
 });
 await t.test('pilot oversized metadata fails closed',async pilot=>{
 let index=0;for(const body of [
 `<label>${'L'.repeat(150000)}<input></label>`,
 `<span id="d">${'D'.repeat(150000)}</span><input aria-describedby="d">`,
 `<input pattern="${'a'.repeat(150000)}">`,
 `<select><option value="${'v'.repeat(150000)}">Small</option></select>`,
 `<select><option>${'O'.repeat(150000)}</option></select>`,
 `<input id="${'i'.repeat(150000)}">`,
 `<input name="${'n'.repeat(150000)}">`,
 `<select>${'<option>x</option>'.repeat(501)}</select>`,
 ])await pilot.test(`oversized metadata case ${++index}`,()=>rejected(body));
 });
 await t.test('pilot traversal exhaustion cannot certify late password absence',async pilot=>{
 await pilot.test('visited nodes',async()=>{
 await load(`${'<span></span>'.repeat(25000)}<input type="password">`);
 await page.evaluate(()=>{
 const original=window.getComputedStyle;let reads=0;
 Object.defineProperty(window,'styleReads',{get:()=>reads});
 window.getComputedStyle=(...args)=>{reads++;return original(...args);};
 });
 const before=readdirSync(join(root,'artifacts'));
 await assert.rejects(inspector.inspect(page,'portal',ns),/Incomplete.*budget/);
 const reads=await page.evaluate(()=>Reflect.get(window,'styleReads') as number);
 assert.ok(reads<=20000,`must stop visiting in page, got ${reads}`);t.diagnostic(`Traversal pilot stopped at ${reads} style reads before 25,000 spans / late password.`);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);
 });
 await pilot.test('field collection',()=>rejected(`${'<input>'.repeat(501)}<input type="password">`));
 });
 await t.test('pilot total materialization exhaustion fails without persistence',async()=>{
 await load(Array.from({length:450},(_,i)=>`<input name="f${i}" pattern="${'x'.repeat(1500)}">`).join(''));
 await page.evaluate(()=>{
 const original=Element.prototype.getAttribute;let reads=0;
 Object.defineProperty(window,'patternReads',{get:()=>reads});
 Element.prototype.getAttribute=function(name){if(name==='pattern')reads++;return original.call(this,name);};
 });
 const before=readdirSync(join(root,'artifacts'));
 await assert.rejects(inspector.inspect(page,'portal',ns),/Incomplete.*budget/);
 const reads=await page.evaluate(()=>Reflect.get(window,'patternReads') as number);
 assert.ok(reads>0&&reads<450,`must stop materializing in page, got ${reads}`);t.diagnostic(`Materialization pilot stopped at ${reads} of 450 pattern reads.`);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);
 });
 await t.test('pilot hidden authentication and oversized identity are not truncated',async pilot=>{
 await pilot.test('hidden password',()=>rejected('<input type="password" hidden>',/Authentication.*operator/));
 await pilot.test('exact URL identity',async()=>{
 await load('<input>');const oversized=url+'&identity='+'a'.repeat(9000);await page.goto(oversized);
 const other=new BrowserPageInspector(store,new WebReader(store,{portal:oversized},[new URL(url).origin]));
 const before=readdirSync(join(root,'artifacts'));
 await assert.rejects(other.inspect(page,'portal',ns),/[Ii]dentity|[Oo]versized|[Ll]imit/);
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);
 });
 });
 await t.test('bounded related collections and ordinary constraints',async()=>{
 await rejected(`${'<label for="f">x</label>'.repeat(33)}<input id="f">`);
 await rejected(`<input aria-describedby="${Array.from({length:33},(_,i)=>`d${i}`).join(' ')}">`);
 await load('<label>Code<input name="code" required pattern="[A-Z]+" minlength="2" maxlength="8" min="1" max="9"></label><textarea name="note">invented entry must not be read</textarea>');
 const result=await inspector.inspect(page,'portal',ns);const field=result.observed.fields[0]!;
 assert.equal(field.pattern,'[A-Z]+');assert.equal(field.minLength,'2');assert.equal(field.maxLength,'8');
 assert.equal(field.min,'1');assert.equal(field.max,'9');assert.doesNotMatch(result.observed.text,/invented entry/);
 await load(`<p>${'"'.repeat(40000)}</p><div style="visibility:hidden"><label style="visibility:visible">Visible again<input name="visible"></label></div>`);
 const bounded=await inspector.inspect(page,'portal',ns);assert.ok(bounded.artifact.bytes<=512000);
 assert.match(bounded.observed.text,/Visible again/);assert.equal(bounded.observed.fields[0]?.name,'visible');
 await rejected(`<p>${'x'.repeat(100001)}</p><input type="password">`);
 });
 await t.test('navigation and late real evaluation cannot persist after cancellation or deadline',async()=>{
 await load('<label>Ordinary<input></label>');
 const before=readdirSync(join(root,'artifacts'));
 await assert.rejects(inspector.inspect({url:()=>page.url(),evaluate:async fn=>{
 const result=await page.evaluate(fn);await page.evaluate(()=>history.replaceState(null,'','?revision=3'));return result;
 }},'portal',ns),/Stale browser navigation/);
 for(const cancel of [true,false]){
 await load('<label>Ordinary<input></label>');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let late:Promise<unknown>|undefined;const controller=new AbortController();
 const bounded=new BrowserPageInspector(store,new WebReader(store,{portal:url},[new URL(url).origin]),20);
 const pending=bounded.inspect({url:()=>page.url(),evaluate:fn=>{
 const work=gate.then(()=>page.evaluate(fn));late=work;return work;
 }},'portal',ns,controller.signal);
 if(cancel){controller.abort();await assert.rejects(pending);}else await assert.rejects(pending,/deadline/);
 release();await late; // Actual Chromium extraction finishes after the inspector returned.
 assert.deepEqual(readdirSync(join(root,'artifacts')),before);
 }
 });
 }finally{await browser?.close();store.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(root,{recursive:true,force:true});}
});
