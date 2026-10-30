import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EvidenceStore } from '../../core/evidence/store.js';
import { resolveOcr } from '../../core/evidence/ocr.js';
import { createOcrTool } from '../../core/tools/ocr.js';
import type { ToolContext } from '../../core/agent/contracts.js';
// Generated solid RGB 3x2 invented image with Pillow; a real JPEG, not just SOF headers.
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3CiiigD//2Q==','base64');
function exif(orientation:number,little=true):Buffer {
 const t=Buffer.alloc(26);t.write(little?'II':'MM'); const u16=(n:number,p:number)=>little?t.writeUInt16LE(n,p):t.writeUInt16BE(n,p);const u32=(n:number,p:number)=>little?t.writeUInt32LE(n,p):t.writeUInt32BE(n,p);
 u16(42,2);u32(8,4);u16(1,8);u16(0x112,10);u16(3,12);u32(1,14);u16(orientation,18);
 const payload=Buffer.concat([Buffer.from('Exif\0\0'),t]);const h=Buffer.from([255,225,0,0]);h.writeUInt16BE(payload.length+2,2);return Buffer.concat([jpeg.subarray(0,2),h,payload,jpeg.subarray(2)]);
}
test('JPEG original bytes, MIME, identity EXIF and source geometry cross HTTP; malformed/oriented inputs never egress',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ocr-jpeg-'));const store=new EvidenceStore(root);const ns={workspaceId:'invented',accountId:'sample'};let expected:Buffer=jpeg;let requests=0;
 const server=createServer(async(req,res)=>{requests++;const parts:Buffer[]=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString());assert.equal(body.input[0].url,`data:image/jpeg;base64,${expected.toString('base64')}`);res.end(JSON.stringify({model:'mock-nim',data:[{index:0,text_detections:[{text_prediction:{text:'0012'},bounding_box:{points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}}]}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const tool=createOcrTool({store,endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/ocr`,allowLoopback:true,authorize:()=>true});
 const invoke=async(bytes:Buffer,mime='image/jpeg',signal=new AbortController().signal)=>{const source=store.put(ns,bytes,mime,[],{provider:'user'}).source!;const ctx:ToolContext={callId:'c',taskId:'t',runId:'r',...ns,budget:{limit:10,used:0},scope:{sources:[source],destinations:[],grants:['image.processing']},signal,isCurrent:()=>true};return {result:await tool.invoke({sourceId:source.id},ctx),source};};
 try {
 for(const bytes of [jpeg,exif(1),exif(1,false)]){expected=bytes;const {result,source}=await invoke(bytes);assert.equal(result.status,'ok');const data=result.data as any;assert.equal(data.sourceWidthPx,3);assert.equal(data.sourceHeightPx,2);assert.equal(data.spans[0].text,'0012');const regions=resolveOcr(store,ns,result.artifacts[0].id,source.id,source.sha256,[data.spans[0].id]);assert.deepEqual(regions[0].polygon,[{x:0,y:0},{x:3,y:0},{x:3,y:2}]);assert.deepEqual(store.read(ns,source.snapshotArtifactId),bytes);}
 const before=requests;
 const badOffset=exif(1);badOffset.writeUInt32LE(0xfffffff0,16);
 const badCount=exif(1);badCount.writeUInt16LE(1025,20);
 const chained=exif(1);chained.writeUInt32LE(8,34);
 const badType=exif(1);badType.writeUInt16LE(4,24);
 for(const bytes of [badOffset,badCount,chained,badType,exif(6),exif(0),exif(9),Buffer.from([255,216,255,225,255,255]),jpeg.subarray(0,100),Buffer.concat([jpeg.subarray(0,2),Buffer.from([255,225,0,1]),jpeg.subarray(2)])]){const {result}=await invoke(bytes);assert.equal(result.status,'failed');assert.equal(result.artifacts.length,0);assert.equal(requests,before);}
 assert.equal((await invoke(jpeg,'image/png')).result.status,'failed');assert.equal(requests,before);
 const c=new AbortController();c.abort();await assert.rejects(invoke(jpeg,'image/jpeg',c.signal),/Stale/);assert.equal(requests,before);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
