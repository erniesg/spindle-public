import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {GoogleWakeJournal} from '../../core/connectors/google/wake-journal.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const route={route:'r',workspace:'w',account:'a',epoch:'e'};
test('pending push survives recovery coalescing; completed hints never label recovery',()=>{
 const j=new GoogleWakeJournal(':memory:');try{
 j.enqueue(route,'push',{receiptAt:100});j.enqueue(route,'recovery:1');
 const claim=j.claim(route,1000)!;assert.equal(claim.receipt?.delivery,'push');
 j.complete(claim,1001);j.enqueue(route,'recovery:2');const recovery=j.claim(route,1002)!;assert.equal(recovery.receipt,undefined);
 j.complete(recovery,1003);j.enqueue(route,'older-arrival',{receiptAt:50});assert.equal(j.claim(route,1004)?.receipt,undefined);
 }finally{j.close();}
});
test('claim uses a serialized snapshot; later cross-instance push stays pending',()=>{
 const dir=mkdtempSync(join(tmpdir(),'snapshot-'));const path=join(dir,'journal');const a=new GoogleWakeJournal(path),b=new GoogleWakeJournal(path);
 try{
 // Deterministic interleaving at the exact former autocommit gap: another
 // connection must be unable to enqueue between UPDATE and receipt SELECT.
 const db=(a as unknown as {db:DatabaseSync}).db,prepare=db.prepare.bind(db);let interleaved=false;
 db.prepare=((sql:string)=>{
  const statement=prepare(sql);
  if(sql.startsWith('UPDATE google_wake SET token=')){
   const get=statement.get.bind(statement);
   statement.get=((...args:Parameters<typeof get>)=>{const row=get(...args);interleaved=true;assert.throws(()=>b.enqueue(route,'racing',{receiptAt:150}),/locked/);return row;}) as typeof statement.get;
  }
  return statement;
 }) as typeof db.prepare;
 a.enqueue(route,'first',{receiptAt:100});const claim=a.claim(route,1000)!;assert.equal(interleaved,true);
 b.enqueue(route,'next',{receiptAt:200});assert.equal(claim.receipt?.delivery,'first');a.complete(claim,1001);
 const next=b.claim(route,1002)!;assert.equal(next.receipt?.delivery,'next');assert.ok(next.sequence>claim.sequence);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('latest status page bounds JSON parsing; replay count saturates safely',()=>{
 const dir=mkdtempSync(join(tmpdir(),'page-'));const path=join(dir,'journal');const j=new GoogleWakeJournal(path),s=new AgentStore(':memory:');const db=new DatabaseSync(path);
 try{
 j.enqueue(route,'p');const claim=j.claim(route)!;
 const task=s.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'inspect'},10);
 const key=claim.key;const insert=db.prepare('INSERT INTO google_admission VALUES (?,?,?,0)');
 db.exec('BEGIN');for(let i=0;i<3000;i++)insert.run(key,'old'+i,'invalid historic JSON');db.exec('COMMIT');
 j.recordAdmission(claim,{task,disposition:'inserted',observedAt:Date.now()},true);
 const page=j.admissionPage(route,1);assert.equal(page.total,3001);assert.equal(page.hasMore,true);assert.equal(page.items.length,1);assert.equal(page.items[0].taskId,task.id);
 db.prepare('UPDATE google_admission SET replays=? WHERE task=?').run(Number.MAX_SAFE_INTEGER,task.id);
 j.recordAdmission(claim,{task,disposition:'existing',observedAt:Date.now()},true);assert.equal(j.admissionPage(route,1).items[0].replays,Number.MAX_SAFE_INTEGER);
 }finally{db.close();s.close();j.close();rmSync(dir,{recursive:true,force:true});}
});
