import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abortRace} from '../../core/connectors/google/abort.js';
import {boundedBytes} from '../../core/connectors/google/bounded.js';
test('independent waiters cancel without inheriting another waiter lifecycle',async()=>{
 let resolve!:(v:number)=>void;const shared=new Promise<number>(r=>resolve=r);
 const a=new AbortController(),b=new AbortController();
 const first=abortRace(shared,a.signal),second=abortRace(shared,b.signal);
 a.abort();await assert.rejects(first);resolve(42);assert.equal(await second,42);
});
test('late dependency rejection remains observed after caller abort',async()=>{
 let reject!:(e:Error)=>void;const work=new Promise<never>((_,r)=>reject=r),c=new AbortController();
 const result=abortRace(work,c.signal);c.abort();await assert.rejects(result);reject(Error('late'));await new Promise(r=>setImmediate(r));
});
test('body cancellation settles even when reader cancellation never settles',async()=>{
 const response=new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}));
 const c=new AbortController();const result=boundedBytes(response,10,c.signal);c.abort();await assert.rejects(result);
});
