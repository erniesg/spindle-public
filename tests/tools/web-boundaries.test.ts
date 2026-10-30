import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {WebReader,TavilySearch} from '../../core/tools/web.js';
import {BrowserPageInspector} from '../../core/tools/page-inspector.js';
test('admission collections cannot be expanded and inspection requires exact admitted URL',async()=>{
 const root=mkdtempSync(join(tmpdir(),'web-boundary-'));const store=new EvidenceStore(root);
 try {const refs={portal:'https://example.org/form'};const origins:string[]=[];const reader=new WebReader(store,refs,origins);
 refs.portal='http://127.0.0.1:9999/';origins.push('http://127.0.0.1:9999');assert.equal(reader.resolve('portal'),'https://example.org/form');assert.throws(()=>reader.check(refs.portal));
 const inspector=new BrowserPageInspector(store,reader,20);let evaluated=false;
 await assert.rejects(inspector.inspect({url:()=> 'https://example.org/other',evaluate:async()=>{evaluated=true;throw Error('unexpected');}},'portal',{workspaceId:'w',accountId:'a'}),/destination/);assert.equal(evaluated,false);
 await assert.rejects(inspector.inspect({url:()=>refs.portal='https://example.org/form',evaluate:()=>new Promise(()=>{})},'portal',{workspaceId:'w',accountId:'a'}),/deadline/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('credential deadline and cancellation prevent late fetch; fixed endpoint still works',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{calls++;assert.equal(input,'https://api.tavily.com/search');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer invented');return new Response(JSON.stringify({results:[]}));};
 try {
 await assert.rejects(new TavilySearch(()=>new Promise(()=>{}),20).search('requirements'),/deadline/);
 let resolve!:(key:string)=>void;const credential=new Promise<string>(r=>{resolve=r;});const controller=new AbortController();const pending=new TavilySearch(()=>credential,100).search('requirements',controller.signal);controller.abort();await assert.rejects(pending);resolve('invented');await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);
 const cancelled=new AbortController();cancelled.abort();let lookedUp=false;await assert.rejects(new TavilySearch(async()=>{lookedUp=true;return 'invented';}).search('requirements',cancelled.signal));assert.equal(lookedUp,false);
 assert.deepEqual(await new TavilySearch(async()=> 'invented').search('requirements'),[]);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
