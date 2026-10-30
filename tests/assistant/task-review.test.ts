import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../../core/storage/agent-store.js';
import { DatabaseSync } from 'node:sqlite';

test('malformed absolute request target returns 400 without terminating the server', {timeout:8000}, async()=>{
 const moduleUrl=new URL('../../core/assistant/app.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {startTaskReview} from ${JSON.stringify(moduleUrl)};const app=await startTaskReview({},{});console.log(app.origin);`],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const watchdog=setTimeout(()=>child.kill(),6000);
 try {
 const [data]=await once(child.stdout,'data');const origin=String(data).trim();const url=new URL(origin);
 const response=await new Promise<string>((resolve,reject)=>{let result='';const socket=connect(Number(url.port),'127.0.0.1',()=>socket.end(`GET http://[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`));socket.on('data',b=>{result+=b;});socket.on('end',()=>resolve(result));socket.on('error',reject);});
 assert.match(response,/^HTTP\/1.1 400/);assert.equal((await fetch(origin)).status,200);assert.equal(child.exitCode,null);assert.equal(stderr,'');
 }finally{clearTimeout(watchdog);child.kill();await once(child,'exit');}
});

test('committed task transitions queue once, roll back together and survive restart/ack with namespace isolation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'task-review-')); const path=join(dir,'agent.db');
 let store=new AgentStore(path); const ns={workspaceId:'invented',accountId:'fictional'};
 try {
 const event={...ns,messageId:'one',outcome:'Prepare an invented workshop request'};
 const task=store.admit(event,8); assert.equal(store.admit(event,8).id,task.id);
 assert.equal(store.notifications(ns).length,1);
 store.update(task.id,t=>{t.nextAction='Still inspecting';}); assert.equal(store.notifications(ns).length,1);
 assert.throws(()=>store.update(task.id,t=>{t.status='ready';throw Error('rollback');}));
 assert.equal(store.notifications(ns).length,1);
 const fault=new DatabaseSync(path);fault.exec("CREATE TRIGGER reject_commit AFTER UPDATE ON agent_tasks BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 assert.throws(()=>store.update(task.id,t=>{t.status='ready';}),/injected failure/);
 assert.equal(store.notifications(ns).length,1);assert.equal(store.get(task.id).status,'working');
 fault.exec('DROP TRIGGER reject_commit');fault.close();
 store.update(task.id,t=>{t.status='blocked';}); store.update(task.id,t=>{t.status='working';});
 store.update(task.id,t=>{t.status='ready';});
 store.close();store=new AgentStore(path);
 assert.deepEqual(store.notifications(ns).map(n=>n.kind),['working','blocked','working','ready']);
 assert.equal(store.tasks({...ns,accountId:'other'}).length,0);
 assert.equal(store.notifications({...ns,accountId:'other'}).length,0);
 const notice=store.notifications(ns)[0]!;
 assert.equal(store.acknowledge({...ns,accountId:'other'},notice.id),false);
 assert.equal(store.acknowledge(ns,notice.id),true);assert.equal(store.acknowledge(ns,notice.id),true);
 store.close();store=new AgentStore(path);assert.equal(store.notifications(ns).length,3);
 assert.equal(store.tasks(ns)[0]!.status,'ready');
 store.cancel(task.id);assert.equal(store.notifications(ns).at(-1)!.kind,'cancelled');
 assert.equal(store.taskInNamespace({...ns,accountId:'other'},task.id),undefined);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
