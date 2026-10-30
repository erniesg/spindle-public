// Actual extracted Windows package; both launches stay paused. No capture consent.
import {spawn,execFileSync} from 'node:child_process';import {createInterface} from 'node:readline';import {readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import assert from 'node:assert/strict';
if(process.platform!=='win32'||!process.argv[2])throw Error('Usage on Windows: node application-owner.mjs PACKAGE_ROOT');
const root=resolve(process.argv[2]),children=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function launch(){
 const child=spawn(join(root,'runtime/node.exe'),[join(root,'build/core/preview/app.js')],{stdio:['ignore','pipe','pipe'],windowsHide:true});let credentials;
 const item={child,get credentials(){return credentials;}};children.push(item);
 item.startup=new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('APP_STARTUP_TIMEOUT')),7000);createInterface({input:child.stdout}).on('line',line=>{const m=line.match(/Spindle PREVIEW: (http:\/\/127\.0\.0\.1:\d+)\/#([a-f0-9]+)/);if(m){credentials={origin:m[1],token:m[2]};clearTimeout(timer);ok('listening');}});child.stderr.on('data',()=>{});child.once('exit',()=>{clearTimeout(timer);ok('exited');});child.once('error',e=>{clearTimeout(timer);no(e);});});return item;
}
async function api(item,path,body){const{origin,token}=item.credentials;const r=await fetch(origin+'/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200);return r.json();}
try{
 const first=launch();assert.equal(await first.startup,'listening');let ready=false;for(let i=0;i<60;i++){const s=await api(first,'state');assert.equal(s.recording,false);if(s.provider==='ready'&&s.settingsReady){ready=true;break;}await sleep(100);}assert.ok(ready,'First native/DPAPI owner ready');
 const path=join(process.env.LOCALAPPDATA,'SpindlePreview','connection.json'),before=await readFile(path);
 const second=launch();const result=await second.startup;await sleep(700);
 assert.equal(result,'exited','Second app must exit before publishing a control endpoint');assert.ok(second.child.exitCode!==null&&second.child.exitCode!==0,'Duplicate launch must fail closed');
 assert.ok(before.equals(await readFile(path)),'Second launch cannot replace the first owner browser connection');
 const s=await api(first,'state');assert.equal(s.provider,'ready');assert.equal(s.recording,false);
 await api(first,'start',{apps:[],pixels:false,rich:false,retain:false});await sleep(300);const gapsBefore=(await api(first,'feedback')).gaps;
 const workerIds=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${first.child.pid}' | Where-Object { $_.Name -eq 'SpindlePreview.exe' -and $_.CommandLine -notmatch '--owner-lease' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`],{encoding:'utf8'})||'[]');
 const workers=Array.isArray(workerIds)?workerIds:[workerIds];assert.equal(workers.length,1,'One owned capture worker');process.kill(workers[0]);await sleep(500);
 assert.equal((await api(first,'state')).recording,false,'Worker crash cannot resume recording');
 assert.ok((await api(first,'feedback')).gaps>gapsBefore,'An unexpected worker loss must disclose a coverage gap');
 const third=launch();assert.equal(await third.startup,'exited','Capture worker crash must not release the still-live application owner');
 assert.ok(before.equals(await readFile(path)),'Worker loss cannot permit connection replacement');
 console.log('PASS duplicate launch and capture-worker-crash ownership; original paused connection unchanged');
}finally{
 for(const item of [...children].reverse()){if(item.credentials)try{await api(item,'quit',{});}catch{};}
 await sleep(700);for(const{child}of children)if(child.exitCode===null)child.kill();
}
