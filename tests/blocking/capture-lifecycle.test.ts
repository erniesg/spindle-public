import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {object,validCommand} from '../../core/pomodoro/protocol.js';
import {installPurposeTransport} from '../../browser-extension/blocking/purpose-client.js';

// Execute the actual capture worker; defer its native challenge reply while
// storage events arrive. This is a production-code seam, not native acceptance.
async function capture(changes:Record<string,unknown>,area:string){
 const source=await readFile(new URL('../../browser-extension/preview/worker.js',import.meta.url),'utf8');
 const dispatch=await readFile(new URL('../../browser-extension/pomodoro/dispatch.js',import.meta.url),'utf8');
 const purpose=await readFile(new URL('../../browser-extension/preview/purpose-transport.js',import.meta.url),'utf8');
 const listeners:Record<string,Function>={};const event=(key:string)=>({addListener:(fn:Function)=>{listeners[key]=fn;}});
 let nativeReply!:Function,challenge!:Record<string,unknown>;const sent:Record<string,any>[]=[];
 const tab={id:1,url:'http://example.test/lesson',active:true,incognito:false,title:'Invented'};
 const win={id:1,focused:true,incognito:false,tabs:[tab]};
 const chrome={runtime:{onMessage:event('message'),onSuspend:event('suspend'),connectNative:()=>({onMessage:{addListener:(fn:Function)=>{nativeReply=fn;}},onDisconnect:event('disconnect'),postMessage:(m:Record<string,any>)=>{sent.push(m);if(m.kind==='challenge')challenge=m;else queueMicrotask(()=>nativeReply({id:m.id,ok:true}));}})},
 storage:{onChanged:event('storage'),local:{get:async()=>({profileToken:'invented',origins:['http://example.test']})}},
 permissions:{contains:async()=>true,onRemoved:event('permissions')},windows:{getLastFocused:async()=>win,get:async()=>win,onFocusChanged:event('focus')},
 tabs:{get:async()=>tab,onActivated:event('activate'),onUpdated:event('update')},action:{onClicked:event('click'),setBadgeText:async()=>{}},
 scripting:{executeScript:async(options:any)=>options.func.name==='visibleText'?[{documentId:'document',result:{text:'Invented lesson'}}]:[{result:true}]}};
 const context={chrome,URL,Map,console,setTimeout,clearTimeout,AbortController,TextEncoder,performance,installPurposeTransport,setInterval:()=>0,visibleText:function visibleText(){},pixelDocument:()=>{},object,validCommand};
 // Load both real additive dispatchers plus the real purpose installer. No
 // dummy transport/bypass may make capture-fence assertions silently pass.
 runInNewContext(dispatch.replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\n'+purpose.replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\n'+source.replace(/^import .*;\n/gm,''),context);
 listeners.update(1,{status:'complete'});
 for(let i=0;i<20&&!challenge;i++)await new Promise(r=>setImmediate(r));
 assert.ok(challenge,'capture must reach deferred native challenge');
 listeners.storage(changes,area);nativeReply({id:challenge.id,challenge:{invented:true},rich:false});
 for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 return sent.filter(m=>m.kind==='context');
}
for(const [area,changes] of [['session',{blockingGrants:{newValue:{}}}],['local',{sitePolicy:{newValue:{version:2}},sitePolicyRevision:{newValue:2}}]] as const){
 test(`blocking ${area} writes preserve in-flight capture`,async()=>assert.equal((await capture(changes,area)).length,1));
}
for(const key of ['profileToken','origins','automaticRich'])for(const removed of [false,true])test(`capture ${key} ${removed?'removal':'change'} invalidates in-flight capture`,async()=>assert.equal((await capture({[key]:removed?{oldValue:'old'}:{oldValue:'old',newValue:'new'}},'local')).length,0));
test('mixed blocking and capture revoke still invalidates',async()=>assert.equal((await capture({sitePolicy:{},profileToken:{oldValue:'invented'}},'local')).length,0));
test('unknown local changes remain conservative invalidation',async()=>assert.equal((await capture({futureCaptureSetting:{}},'local')).length,0));
