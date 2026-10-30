import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleWakeJournal } from '../../core/connectors/google/wake-journal.js';
const route={route:'r',workspace:'w',account:'invented@example.test',epoch:'e'};
test('distinct authenticated receipt timing persists without duplicate refresh on reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-latency-'));const path=join(dir,'journal.sqlite');
 let journal=new GoogleWakeJournal(path);
 try {
  assert.equal(journal.enqueue(route,'one',{receiptAt:2000,publishAt:1000}),true);
  journal.close();journal=new GoogleWakeJournal(path);
  assert.equal(journal.enqueue(route,'one',{receiptAt:9000,publishAt:8000}),false);
  assert.deepEqual({...journal.receiptStatus(route)},{delivery:'one',receiptAt:2000,publishAt:1000});
  journal.enqueue(route,'recovery:1');
  assert.equal((journal.receiptStatus(route) as any).receiptAt,2000);
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('missing and future publish times remain unknown and older concurrent receipts do not replace newest',()=>{
 const journal=new GoogleWakeJournal(':memory:');
 try {
  journal.enqueue(route,'one',{receiptAt:2000,publishAt:3000});
  assert.equal((journal.receiptStatus(route) as any).publishAt,null);
  journal.enqueue(route,'older',{receiptAt:1000,publishAt:500});
  assert.equal((journal.receiptStatus(route) as any).receiptAt,2000);
  journal.enqueue(route,'two',{receiptAt:4000});
  assert.equal((journal.receiptStatus(route) as any).publishAt,null);
  assert.equal(journal.receiptStatus({...route,epoch:'other'}),undefined);
 }finally{journal.close();}
});
test('invalid receipt does not advance durable wake counters',()=>{
 const journal=new GoogleWakeJournal(':memory:');
 try {
  assert.throws(()=>journal.enqueue(route,'bad',{receiptAt:NaN}));
  assert.equal(journal.status(route),undefined);
  assert.equal(journal.receiptStatus(route),undefined);
 }finally{journal.close();}
});
