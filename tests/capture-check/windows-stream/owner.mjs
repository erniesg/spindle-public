// Native Windows guard test. No Start/key command, recording or fixture windows.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
if(process.platform!=='win32'||!process.argv[2])throw Error('Usage on Windows: node owner.mjs RUNTIME_DIRECTORY');
const executable=resolve(process.argv[2],'SpindlePreview.exe'),children=[];
async function launch(){
 const child=spawn(executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);
 const hello=await new Promise((ok,no)=>{
  const timeout=setTimeout(()=>no(Error('NATIVE_STARTUP_TIMEOUT')),5000);
  createInterface({input:child.stdout}).on('line',line=>{const e=JSON.parse(line);if(e.kind==='ready'||e.kind==='error'){clearTimeout(timeout);ok(e);}});
  child.once('error',e=>{clearTimeout(timeout);no(e);});
 });return{child,hello};
}
try{
 const first=await launch();assert.equal(first.hello.kind,'ready','First owner must be available');
 const second=await launch();assert.equal(second.hello.code,'WINDOWS_CAPTURE_OWNER_BUSY','A second native helper must refuse ownership');
 assert.equal(first.child.exitCode,null,'Duplicate launch must leave first owner alive');
 console.log('PASS native duplicate-owner denial; first helper remains alive; no recording started');
}finally{
 for(const child of children){if(child.exitCode===null&&!child.stdin.destroyed)child.stdin.write('{"schema":"spindle-native-preview/v1","action":"quit"}\n');}
 await new Promise(r=>setTimeout(r,500));for(const child of children)if(child.exitCode===null)child.kill();
}
