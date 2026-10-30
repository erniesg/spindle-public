// Offline: scripted search provider and HTTP; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createWebSearchTools,privateQueryReason} from '../../core/tools/web-search.js';
import type {ToolContext} from '../../core/agent/contracts.js';
function fixture(pages:Record<string,Response|(()=>Response)>={}){
 const dir=mkdtempSync(join(tmpdir(),'web-search-')),store=new EvidenceStore(dir),queries:string[]=[],fetched:string[]=[];
 const ctx=(taskId='t'):ToolContext=>({callId:'c'+Math.random(),taskId,runId:'r',workspaceId:'w',accountId:'a',scope:{sources:[],destinations:[],grants:[]},budget:{used:0,limit:10},signal:new AbortController().signal,isCurrent:()=>true});
 const search={async search(query:string){queries.push(query);return [{sourceId:'x',url:'https://www.ica.gov.sg/photo-guidelines',title:'Photo guidelines',selectedText:'Photo must be 400 x 514 pixels'},{sourceId:'y',url:'https://example.org/other',title:'Other',selectedText:'...'}];}};
 const http:typeof fetch=async input=>{const url=String(input);fetched.push(url);const page=pages[url];if(!page)return new Response('missing',{status:404});return typeof page==='function'?page():page;};
 const [webSearch,open]=createWebSearchTools({store,search,blockedTerms:()=>['TAN AH KOW','123-45678-9'],http});
 return {store,ctx,queries,fetched,run:(tool:typeof webSearch,args:unknown,c=ctx())=>tool.invoke(tool.inputSchema.parse(args),c),webSearch:webSearch!,open:open!,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('privacy guard keeps personal data out of search queries',()=>{
 for(const q of ['photo for TAN AH KOW','account 123-45678-9 giro','nric S1234567D photo','email me at a@b.co','call 98765432'])assert.ok(privateQueryReason(q,['TAN AH KOW','123-45678-9']),q);
 assert.equal(privateQueryReason('ICA Singapore passport photo requirements 35 x 45 mm',['TAN AH KOW']),undefined);
});
test('web.search sends only public queries, snapshots results and admits them for this task only',async()=>{
 const f=fixture({'https://www.ica.gov.sg/photo-guidelines':new Response('<html><head><style>x{}</style></head><body><h1>Photo</h1><p>Size: 400 x 514 pixels &amp; white background</p><script>evil()</script></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}})});try{
  const blocked=await f.run(f.webSearch,{query:'GIRO form for tan ah kow'});
  assert.equal(blocked.status,'failed');assert.equal(blocked.effect,'none');assert.equal(blocked.error!.code,'WEB_QUERY_PRIVATE');assert.deepEqual(f.queries,[]);
  const r=await f.run(f.webSearch,{query:'ICA passport photo requirements'});
  assert.equal(r.status,'ok');const results=(r.data as {results:{resultId:string;url:string}[]}).results;assert.equal(results.length,2);assert.equal(r.artifacts.length,1);
  const other=await f.run(f.open,{resultId:results[0]!.resultId},f.ctx('another-task'));assert.equal(other.error!.code,'WEB_RESULT_UNKNOWN');assert.deepEqual(f.fetched,[]);
  const page=await f.run(f.open,{resultId:results[0]!.resultId});assert.equal(page.status,'ok',JSON.stringify(page.error));
  const text=(page.data as {text:string}).text;assert.match(text,/400 x 514 pixels & white background/);assert.doesNotMatch(text,/evil|x\{\}/);assert.equal(page.artifacts.length,1);
  assert.equal((await f.run(f.open,{resultId:'s9r9'})).error!.code,'WEB_RESULT_UNKNOWN');
 }finally{f.close();}
});
test('web.open_result refuses cross-site redirects and non-OK pages without saving anything',async()=>{
 const f=fixture({'https://www.ica.gov.sg/photo-guidelines':()=>new Response(null,{status:302,headers:{location:'https://attacker.example/steal'}}),'https://example.org/other':()=>new Response('no',{status:500})});try{
  const results=((await f.run(f.webSearch,{query:'ICA passport photo requirements'})).data as {results:{resultId:string}[]}).results;
  const before=Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n);
  const redirected=await f.run(f.open,{resultId:results[0]!.resultId});assert.equal(redirected.error!.code,'WEB_OPEN_FAILED');assert.match(redirected.error!.message,/outside the result site/);
  const broken=await f.run(f.open,{resultId:results[1]!.resultId});assert.match(broken.error!.message,/HTTP 500/);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()!.n),before);assert.ok(!f.fetched.some(u=>u.includes('attacker')));
 }finally{f.close();}
});
test('a failing search provider is a no-effect failure, not a crash',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'web-search-')),store=new EvidenceStore(dir);try{
  const [s]=createWebSearchTools({store,search:{async search(){throw Error('Tavily HTTP 401');}},blockedTerms:()=>[]});
  const r=await s!.invoke(s!.inputSchema.parse({query:'photo requirements'}),{callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a',scope:{sources:[],destinations:[],grants:[]},budget:{used:0,limit:1},signal:new AbortController().signal,isCurrent:()=>true});
  assert.equal(r.status,'failed');assert.equal(r.effect,'none');assert.match(r.error!.message,/401/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
