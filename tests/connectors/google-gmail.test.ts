import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmailSync } from '../../core/connectors/google/gmail.js';
import { AgentStore } from '../../core/storage/agent-store.js';
test('Gmail paginates, recovers expired history after restart, and refuses wrong account',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-sync-'));const tasks=new AgentStore(join(dir,'tasks.db'));
 let history=false, wrong=false;const admitted:string[]=[];
 const http=(async(input:unknown)=>{
 const url=new URL(String(input));const path=url.pathname;
 if(path.endsWith('/profile'))return Response.json({emailAddress:wrong?'other@example.invalid':'self@example.invalid',historyId:'9'});
 if(path.endsWith('/history')){history=true;return new Response('',{status:410});}
 if(path.endsWith('/messages'))return Response.json(url.searchParams.has('pageToken')?{messages:[{id:'two'}]}:{messages:[{id:'one'}],nextPageToken:'next'});
 return Response.json({id:path.split('/').pop(),labelIds:['SENT'],from:'self@example.invalid'});
 }) as typeof fetch;
 const relevant=async(message:any)=>{admitted.push(message.id);return 'invented task';};
 let sync=new GmailSync(join(dir,'cursor.db'),tasks,http);
 try {
 await sync.poll('self@example.invalid','demo','invented',relevant);sync.close();
 sync=new GmailSync(join(dir,'cursor.db'),tasks,http);
 await sync.poll('self@example.invalid','demo','invented',relevant);
 assert.equal(history,true);assert.deepEqual(admitted,['one','two','one','two']);
 const first=tasks.admit({workspaceId:'demo',accountId:'self@example.invalid',messageId:'one',outcome:'invented task'},100);
 const replay=tasks.admit(first.sourceEvent,100);assert.equal(first.id,replay.id);
 wrong=true;await assert.rejects(sync.poll('self@example.invalid','demo','invented',relevant),/Wrong Google account/);
 }finally{sync.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
