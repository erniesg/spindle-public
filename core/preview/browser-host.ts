// Fixed Native Messaging bridge, no shell/file/command API. Current-user IPC secret
// is independent of the profile pairing token, which only the enrolled extension knows.
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join,isAbsolute } from 'node:path';
import { dataDirectory } from './app.js';
let buffer=Buffer.alloc(0),inflight=0,timerBusy=false,purposeBusy=false,purposeRevoking=false,earnedBusy=false;
const timerSockets=new Set<import('node:net').Socket>(),purposeSockets=new Set<import('node:net').Socket>(),earnedSockets=new Set<import('node:net').Socket>();
const controlIndex=process.argv.indexOf('--control-directory');
const controlDirectory=controlIndex<0?dataDirectory():process.argv[controlIndex+1];
if(!controlDirectory||!isAbsolute(controlDirectory)||controlIndex>=0&&(controlIndex!==3||process.argv.length!==5))throw Error('INVALID_CONTROL_DIRECTORY');
function reply(id:number,value:Record<string,unknown>){const b=Buffer.from(JSON.stringify({...value,id})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));}
async function handle(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const v=value as Record<string,unknown>,id=typeof v.id==='number'&&Number.isSafeInteger(v.id)&&v.id>0&&v.id<=1000000?v.id:0;
  // Earned leisure has its own single slot: account network never borrows capture/timer capacity.
  const timer=v.kind==='pomodoro',purpose=v.kind==='purpose',earned=v.kind==='earned';
  const priority=Boolean(purpose&&v.data&&typeof v.data==='object'&&!Array.isArray(v.data)&&'action'in v.data&&v.data.action==='revoke');
  if(v.schema!=='spindle-browser-preview/v1'||!id||typeof v.kind!=='string'||!['pair','challenge','context','image','revoke','pomodoro','purpose','earned'].includes(v.kind)||(timer?timerBusy||JSON.stringify(v).length>4096:earned?earnedBusy||Buffer.byteLength(JSON.stringify(v))>4096:purpose?(priority?purposeRevoking:purposeBusy)||Buffer.byteLength(JSON.stringify(v))>10240:inflight>=3||inflight>=2&&v.kind!=='revoke')){reply(id,{ok:false});return;}
  if(timer)timerBusy=true;else if(earned)earnedBusy=true;else if(purpose){if(priority)purposeRevoking=true;else purposeBusy=true;}else inflight++;
  try{const c=JSON.parse(await readFile(join(controlDirectory!,'connection.json'),'utf8'));
    if(typeof c.secret!=='string'||typeof c.ipcPath!=='string'||process.stdin.readableEnded||process.stdin.destroyed)throw new Error();
    const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
      const socket=connect(c.ipcPath);if(timer||purpose||earned){const sockets=earned?earnedSockets:purpose?purposeSockets:timerSockets;sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);reject(new Error('CLOSED'));});}let text='';socket.setTimeout(earned?12000:timer||purpose?1600:2000,()=>socket.destroy(new Error('TIMEOUT')));socket.on('error',reject);
      socket.on('connect',()=>socket.write(JSON.stringify({schema:'spindle-browser-preview/v1',secret:c.secret,kind:v.kind,code:v.code,profileToken:v.profileToken,data:v.data})+'\n'));
      socket.on('data',chunk=>{text+=chunk;if(text.length>20000){socket.destroy();reject(new Error());return;}const index=text.indexOf('\n');if(index>=0){try{const data=JSON.parse(text.slice(0,index));resolve(data);}catch{reject(new Error());}socket.end();}});
      socket.on('end',()=>reject(new Error('CLOSED')));
    });reply(id,result);
  }catch{reply(id,{ok:false});}finally{if(timer)timerBusy=false;else if(earned)earnedBusy=false;else if(purpose){if(priority)purposeRevoking=false;else purposeBusy=false;}else inflight--;if(process.stdin.readableEnded&&!inflight&&!timerBusy&&!purposeBusy&&!purposeRevoking&&!earnedBusy)process.stdout.end();}
}
if(!/^chrome-extension:\/\/[a-p]{32}\/$/.test(process.argv[2]??'')){process.exitCode=1;process.stdin.destroy();}
else process.stdin.on('data',(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>3_000_004){process.stdin.destroy();process.exitCode=1;return;}while(buffer.length>=4){const length=buffer.readUInt32LE(0);if(length>3_000_000){process.stdin.destroy();process.exitCode=1;return;}if(buffer.length<length+4)break;const body=buffer.subarray(4,length+4);buffer=buffer.subarray(length+4);try{void handle(JSON.parse(body.toString('utf8')));}catch{reply(0,{ok:false});}}});
process.stdin.on('end',()=>{for(const socket of [...timerSockets,...purposeSockets,...earnedSockets])socket.destroy();if(!inflight&&!timerBusy&&!purposeBusy&&!purposeRevoking&&!earnedBusy)process.stdout.end();});process.stdout.on('error',()=>process.stdin.destroy());
