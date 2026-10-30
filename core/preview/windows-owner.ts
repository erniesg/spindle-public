import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
// A small OS-mutex lease follows the control process, not a fallible GPU worker.
// Private unref'd pipes retain it while the parent lives, and EOF releases it on
// normal exit or crash. It never creates a capture session or retrieves a key.
export function acquireWindowsPreviewOwner(executable:string):Promise<ChildProcessWithoutNullStreams>{
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['--owner-lease'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    const reader=createInterface({input:child.stdout});let settled=false;
    const fail=(code:string)=>{if(settled)return;settled=true;clearTimeout(timer);reader.close();child.kill();reject(Error(code));};
    const timer=setTimeout(()=>fail('WINDOWS_OWNER_STARTUP_TIMEOUT'),5000);
    child.stdin.on('error',()=>{});child.stderr.resume();
    reader.on('line',line=>{
      if(line.length>4096){fail('WINDOWS_OWNER_PROTOCOL_INVALID');return;}
      try{
        const e=JSON.parse(line);
        if(e.schema!=='spindle-native-preview/v1'){fail('WINDOWS_OWNER_PROTOCOL_INVALID');return;}
        if(e.kind==='error'){fail(e.code==='WINDOWS_CAPTURE_OWNER_BUSY'?e.code:'WINDOWS_OWNER_UNAVAILABLE');return;}
        if(e.kind!=='owner-ready'){fail('WINDOWS_OWNER_PROTOCOL_INVALID');return;}
        for(const stream of [child.stdin,child.stdout,child.stderr]){
          const unref=Reflect.get(stream,'unref');if(typeof unref!=='function'){fail('WINDOWS_OWNER_PIPE_UNAVAILABLE');return;}unref.call(stream);
        }
        child.unref();settled=true;clearTimeout(timer);reader.close();resolve(child);
      }catch{fail('WINDOWS_OWNER_PROTOCOL_INVALID');}
    });
    child.once('error',()=>fail('WINDOWS_OWNER_UNAVAILABLE'));
    child.once('close',()=>fail('WINDOWS_OWNER_STARTUP_FAILED'));
  });
}
