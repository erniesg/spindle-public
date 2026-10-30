import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCallBudget } from '../../core/models/file-budget.js';
import { CallBudget } from '../../core/models/provider.js';
function journal(){const directory=mkdtempSync(join(tmpdir(),'spindle-budget-')),path=join(directory,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}),{mode:0o600});return {directory,path};}
test('cumulative task budget survives new provider/owner instances and retains uncertain spend',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const first=new FileCallBudget(path),id=first.reserve(2),next=new FileCallBudget(path);
 assert.equal(next.snapshot().accountedUsd,2);assert.throws(()=>next.reserve(2),/BUDGET_DENIED/);
 next.settle(id,0.1);assert.equal(new FileCallBudget(path).snapshot().accountedUsd,0.1);
 next.reserve(1);assert.equal(new FileCallBudget(path).snapshot().accountedUsd,1.1);assert.equal(next.snapshot().calls,2);
 assert.throws(()=>new FileCallBudget(join(directory,'missing.json')),/INVALID_BUDGET/);
});
test('explicit Typesafe journal remains separate from default Nebius accounting',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const value=JSON.parse(readFileSync(path,'utf8'));value.provider='typesafe';value.hardTaskLimit=.02;writeFileSync(path,JSON.stringify(value));
 const selected=(file:string,provider:string)=>Reflect.construct(FileCallBudget,[file,provider]) as FileCallBudget;
 assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/,'default must not adopt another provider ledger');
 const first=selected(path,'typesafe'),id=first.reserve(.0055);assert.equal(selected(path,'typesafe').snapshot().calls,1);
 selected(path,'typesafe').settle(id,.0001);assert.equal(selected(path,'typesafe').snapshot().accountedUsd,.0001);
 assert.throws(()=>selected(path,'nebius'),/INVALID_BUDGET/);assert.throws(()=>selected(join(directory,'missing.json'),'typesafe'),/INVALID_BUDGET/);
 value.provider='other';writeFileSync(path,JSON.stringify(value));assert.throws(()=>selected(path,'other'),/INVALID_BUDGET/);
});
test('selected call ceiling is enforced in each cumulative reservation, not a stale snapshot',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const first=new FileCallBudget(path);for(let n=0;n<2;n++){const id=first.reserve(.001);first.settle(id,0);}
 const left=new FileCallBudget(path),right=new FileCallBudget(path);
 assert.equal(left.snapshot().calls,2);assert.equal(right.snapshot().calls,2);
 const reserve=(budget:FileCallBudget|CallBudget,maximum:number)=>Reflect.apply(budget.reserve,budget,[.001,maximum]) as number;
 reserve(left,3);assert.throws(()=>reserve(right,3),/BUDGET_DENIED/);assert.equal(new FileCallBudget(path).snapshot().calls,3);
 const memory=new CallBudget(.02,100);reserve(memory,1);assert.throws(()=>reserve(memory,1),/BUDGET_DENIED/);
 assert.throws(()=>reserve(memory,0),/BUDGET_DENIED/);
});
test('a journal-declared call ceiling survives reconstruction and cannot be widened by callers',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const data=JSON.parse(readFileSync(path,'utf8'));data.maximumCalls=1;writeFileSync(path,JSON.stringify(data));
 new FileCallBudget(path).reserve(.001,100);
 assert.throws(()=>new FileCallBudget(path).reserve(.001,100),/BUDGET_DENIED/);
 assert.equal(new FileCallBudget(path).snapshot().exhausted,true);
 for(const value of [0,2001,1.5,'3',null]){data.maximumCalls=value;writeFileSync(path,JSON.stringify(data));assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/);}
});
test('owner-funded journal bounds: 2000 calls, $25 hard limit and 256KiB are the outer ceilings',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const data=JSON.parse(readFileSync(path,'utf8'));
 data.maximumCalls=2000;data.hardTaskLimit=25;writeFileSync(path,JSON.stringify(data));
 const b=new FileCallBudget(path);assert.equal(b.snapshot().calls,0);b.reserve(24.5,2000);
 assert.throws(()=>new FileCallBudget(path).reserve(1,2000),/BUDGET_DENIED/,'the $25 ceiling still bounds cumulative reservations');
 assert.throws(()=>new FileCallBudget(path).reserve(.001,2001),/BUDGET_DENIED/,'callers cannot exceed the 2000-call bound');
 for(const limit of [25.01,100]){const v={...data,hardTaskLimit:limit,requests:[],reservedWorstCase:0};writeFileSync(path,JSON.stringify(v));assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/);}
 const many=Array.from({length:2001},(_,i)=>({id:i+1,maximumUsd:0,actualUsd:0}));
 writeFileSync(path,JSON.stringify({...data,maximumCalls:undefined,requests:many,reservedWorstCase:0,observedSpend:0}));assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/,'more than 2000 recorded requests is invalid');
 writeFileSync(path,JSON.stringify({...data,requests:[],reservedWorstCase:0,observedSpend:0,padding:'x'.repeat(262145)}));assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/,'journals over 256KiB are refused');
 writeFileSync(path,JSON.stringify({...data,requests:[],reservedWorstCase:0,observedSpend:0,padding:'x'.repeat(200000)}));assert.equal(new FileCallBudget(path).snapshot().calls,0);
});
test('lock contention/corrupt journal cannot reset task budget; accounting overrun stays exhausted',t=>{
 const {directory,path}=journal();t.after(()=>rmSync(directory,{recursive:true,force:true}));const b=new FileCallBudget(path);
 writeFileSync(path+'.lock','invented concurrent owner');assert.throws(()=>b.reserve(1),/BUDGET_DENIED/);rmSync(path+'.lock');assert.equal(b.snapshot().calls,0);
 const id=b.reserve(0.01);assert.throws(()=>b.settle(id,0.02),/BUDGET_ACCOUNTING_ERROR/);assert.equal(new FileCallBudget(path).snapshot().exhausted,true);assert.throws(()=>new FileCallBudget(path).reserve(0.01),/BUDGET_DENIED/);
 const d=JSON.parse(readFileSync(path,'utf8'));d.reservedWorstCase=0;writeFileSync(path,JSON.stringify(d));assert.throws(()=>new FileCallBudget(path),/INVALID_BUDGET/);
});
