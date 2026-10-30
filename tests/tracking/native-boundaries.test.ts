// Production shared seams + valid invented PNGs. NOT native OS execution.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {PreviewSession} from '../../core/preview/session.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
import {validateOperation} from '../../core/tracking/types.js';

function whitePng(width:number,height:number){
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const pixels=Buffer.alloc((width*4+1)*height,255);for(let y=0;y<height;y++)pixels[y*(width*4+1)]=0;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
test('valid 4K compressible Windows-shaped Rich PNG survives collector, durable pending and HTTP history',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/native-boundary-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 const session=new PreviewSession();let sink:CollectorHistory|undefined;
 try{
  let client=new TrackingClient(server.origin,join(dir,'client'),key);await client.signin('native-boundary','invented-password-123','Invented Windows',true);
  sink=new CollectorHistory(session,client,(await client.inspect()).deviceId,3600000);
  session.start({pixels:true,rich:true,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'invented-window',app:'notepad',title:'Invented',clock:'invented-clock',browser:false});await sink.settle();
  const image=whitePng(3840,2160);assert.ok(Buffer.from(image,'base64').length<2000000);
  session.sample({epoch:session.epoch,revision:1,at:1,text:'Invented OCR',textSource:'ocr',image,status:'local-ocr'});await sink.settle();assert.equal(sink.status,'ready');
  session.pause(2);await sink.dispose();sink=undefined;
  client=new TrackingClient(server.origin,join(dir,'client'),key);await client.sync();const entry=(await client.inspect()).entries.find(e=>e.record)!;
  assert.equal(entry.record!.visit.image,image);assert.equal(entry.record!.visit.text,'Invented OCR');
  const forged=Buffer.from(image,'base64');forged.writeUInt32BE(32768,16);forged.writeUInt32BE(32768,20);
  assert.throws(()=>validateOperation({id:'invented-oversize',deviceId:entry.deviceId,recordingId:entry.recordingId,visitId:entry.visitId,record:{...entry.record!,visit:{...entry.record!.visit,image:forged.toString('base64')}}}),/PIXELS_DENIED/,'encoded byte fit must not allow unbounded decoded pixel allocation');
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
test('Mac-shaped atomic Rich frames preserve both fields at Pause; partial/denied refresh never borrows stale context',()=>{
 const session=new PreviewSession();session.start({pixels:true,rich:true,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'invented-mac-window',app:'com.apple.TextEdit',title:'Invented',clock:'invented-clock',browser:false});
 const image=whitePng(8,8),base={epoch:session.epoch,revision:1,textSource:'ocr',status:'pixel-window-readback'};
 session.sample({...base,at:1,text:'Invented first frame',image,framePTS:100});session.sample({...base,at:2,text:'Invented next frame',image,framePTS:101});session.pause(3);
 assert.equal(session.visits[0]!.text,'Invented next frame');assert.equal(session.visits[0]!.image,image);
 session.start({pixels:true,rich:true,retain:true});session.focus({epoch:session.epoch,revision:1,at:3,key:'invented-mac-window',app:'com.apple.TextEdit',title:'Invented',clock:'invented-clock',browser:false});
 session.sample({...base,epoch:session.epoch,at:4,text:'Invented',image});session.sample({...base,epoch:session.epoch,at:5,image});assert.equal(session.active!.text,'');
 session.sample({...base,epoch:session.epoch,at:6,text:'Fresh AX fallback'});assert.equal(session.active!.image,'');
});
