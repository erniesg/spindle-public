import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../../core/storage/agent-store.js';
import { GoogleWakeJournal } from '../../core/connectors/google/wake-journal.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const route={route:'r',workspace:'w',account:'a',epoch:'e'};
const event={workspaceId:'w',accountId:'a',messageId:'m',outcome:'inspect'};
test('observer throws after commit, duplicate returns unchanged task, admission SQL failure propagates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'admission-'));const path=join(dir,'tasks');const store=new AgentStore(path);
 try {
 const task=store.admit(event,10,()=>{throw Error('observer unavailable');});
 let disposition='';assert.deepEqual(store.admit(event,10,o=>{disposition=o.disposition;o.task.status='cancelled';}),task);assert.equal(disposition,'existing');assert.deepEqual(store.get(task.id),task);
 const db=new DatabaseSync(path);db.exec("CREATE TRIGGER deny BEFORE INSERT ON agent_tasks BEGIN SELECT RAISE(ABORT,'denied'); END");db.close();let called=false;
 assert.throws(()=>store.admit({...event,messageId:'other'},10,()=>{called=true;}),/denied/);assert.equal(called,false);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('captured receipt correlation persists; duplicates and recovery never overwrite first admission',()=>{
 const dir=mkdtempSync(join(tmpdir(),'admission-'));const path=join(dir,'journal');let journal=new GoogleWakeJournal(path);const store=new AgentStore(':memory:');
 try {
 const now=Date.now();journal.enqueue(route,'push',{receiptAt:now-20,publishAt:now-40});const claim=journal.claim(route)!;
 journal.enqueue(route,'later',{receiptAt:now});
 const task=store.admit(event,10,o=>journal.recordAdmission(claim,o,true));const original=journal.admissionStatus(route)[0];
 assert.equal(original.disposition,'inserted');assert.equal(original.receipt.delivery,'push');assert.ok(original.receiptToAdmissionMs>=20);
 journal.close();journal=new GoogleWakeJournal(path);store.admit(event,10,o=>journal.recordAdmission(claim,o,false));
 assert.deepEqual({...journal.admissionStatus(route)[0],replays:0},{...original,replays:0});assert.equal(journal.admissionStatus(route)[0].replays,1);assert.equal(journal.admissionStatus({...route,epoch:'new'}).length,0);assert.equal(store.get(task.id).id,task.id);
 }finally{journal.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('journal failure after insert and restart leaves original timing unknown; skew and local mode unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'admission-'));const path=join(dir,'tasks');let store=new AgentStore(path);const journal=new GoogleWakeJournal(':memory:');
 try {
 journal.enqueue(route,'p',{receiptAt:Date.now()+100000});const claim=journal.claim(route)!;
 store.admit(event,10,()=>{throw Error('journal fault');});store.close();store=new AgentStore(path);
 store.admit(event,10,o=>journal.recordAdmission(claim,o,true));assert.equal(journal.admissionStatus(route)[0].admittedAt,null);
 store.admit({...event,messageId:'skew'},10,o=>journal.recordAdmission(claim,o,true));assert.equal(journal.admissionStatus(route)[1].receiptToAdmissionMs,null);
 store.admit({...event,messageId:'local'},10,o=>journal.recordAdmission(claim,o,false));assert.equal(journal.admissionStatus(route)[2].publishToAdmissionMs,null);
 }finally{store.close();journal.close();rmSync(dir,{recursive:true,force:true});}
});
