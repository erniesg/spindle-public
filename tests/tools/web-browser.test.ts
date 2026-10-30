import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {WebReader} from '../../core/tools/web.js';
import {BrowserPageInspector} from '../../core/tools/page-inspector.js';
test('actual Chromium observes changed ordinary labels and constraints',{skip:!process.env.SPINDLE_WEB_CHROMIUM},async()=>{
 let label='Portrait',accept='image/jpeg';
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<title>Invented portal</title><p>Deadline tomorrow. White background.</p><label>${label}<input name="photo" type="file" required accept="${accept}"></label>`);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const root=mkdtempSync(join(tmpdir(),'web-browser-'));const store=new EvidenceStore(root);
 let browser;try {browser=await chromium.launch({executablePath:process.env.SPINDLE_WEB_CHROMIUM,headless:true,args:['--no-sandbox']});}catch(error){store.close();server.close();rmSync(root,{recursive:true,force:true});throw error;}
 try{const page=await browser.newPage();await page.goto(url);const inspector=new BrowserPageInspector(store,new WebReader(store,{portal:url},[new URL(url).origin]));
 const a=await inspector.inspect(page,'portal',{workspaceId:'w',accountId:'a'});assert.equal(a.observed.fields[0]?.label,'Portrait');assert.equal(a.observed.fields[0]?.accept,'image/jpeg');
 label='Optional supporting image';accept='image/png';await page.reload();const b=await inspector.inspect(page,'portal',{workspaceId:'w',accountId:'a'});assert.equal(b.observed.fields[0]?.label,label);assert.equal(b.observed.fields[0]?.accept,accept);assert.notEqual(a.source!.sha256,b.source!.sha256);
 }finally{await browser.close();store.close();server.close();rmSync(root,{recursive:true,force:true});}
});
