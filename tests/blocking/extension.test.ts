import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('installed recovery controls disclose bounded overrides and asynchronous return limitation',async()=>{
 const html=await readFile(new URL('../../browser-extension/preview/blocking.html',import.meta.url),'utf8');
 assert.match(html,/exact case-sensitive URL, target tab, chosen purpose and policy version/);
 assert.match(html,/Departure cancellation and SPA re-gating are asynchronous/);
 assert.match(html,/return to the same resource before cancellation can reach the server without renewed review/);
 assert.doesNotMatch(html,/Exceptions end on.*navigation away/);
});

test('installed whole-site controls do not require a purpose',async()=>{
 const html=await readFile(new URL('../../browser-extension/preview/blocking.html',import.meta.url),'utf8');
 const purpose=html.match(/<input\b[^>]*\bid="purpose"[^>]*>/)?.[0];
 assert.ok(purpose);assert.doesNotMatch(purpose,/\brequired\b/);
 assert.match(html,/Allowed purpose \(optional/);
});

test('override feedback is explicitly historical, not a stale live grant indicator',async()=>{
 const controls=await readFile(new URL('../../browser-extension/preview/blocking/controls.js',import.meta.url),'utf8');
 assert.match(controls,/Last action: explicit override applied/);
 assert.doesNotMatch(controls,/Explicit override active/);
});

test('a new Jev click clears the preceding result before asynchronous policy preparation',async()=>{
 const source=await readFile(process.env.SPINDLE_CONTROLS_SOURCE??new URL('../../browser-extension/preview/blocking/controls.js',import.meta.url),'utf8');
 const elements=new Map<string,any>(),handlers=new Map<string,Function>();let release!:(value:unknown)=>void;
 const element=(name:string)=>{if(!elements.has(name))elements.set(name,{textContent:'',value:'',checked:false,addEventListener:(event:string,fn:Function)=>handlers.set(name+':'+event,fn),append:()=>{}});return elements.get(name);};
 const chrome={runtime:{sendMessage:async()=>({ok:true,absenceVerified:true})},storage:{local:{get:()=>new Promise(resolve=>{release=resolve;})},onChanged:{addListener:()=>{}}},tabs:{query:async()=>[]}};
 runInNewContext(source.replace(/^export \{\};?\s*$/gm,''),{document:{querySelector:element,createElement:()=>({})},chrome});
 await new Promise(resolve=>setImmediate(resolve));element('output').textContent='Last action: Jev eligibility passed for the PREVIOUS resource.';
 handlers.get('#jev-review:click')!();assert.match(element('output').textContent,/^Reviewing/);
 release({sitePolicy:{version:1}});await new Promise(resolve=>setImmediate(resolve));
});
test('installed guard is a classic content script and admission stays inside extension root',async()=>{
 const root=new URL('../../browser-extension/preview/',import.meta.url);
 const guard=await readFile(new URL('blocking/guard.js',root),'utf8');
 assert.doesNotMatch(guard,/\bexport\s/);
 const worker=await readFile(new URL('blocking/worker.js',root),'utf8');
 assert.match(worker,/from '\.\/core\/admission.js'/);
 const admission=await readFile(new URL('blocking/core/admission.js',root),'utf8');
 assert.match(admission,/function admitResource/);
});
