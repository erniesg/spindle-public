// Explicit operator-selected cumulative journal. No model or HTTP input chooses
// this path. A crash leaves reservations charged; lock contention fails closed.
import { closeSync,ftruncateSync,fsyncSync,lstatSync,openSync,readFileSync,unlinkSync,writeFileSync } from 'node:fs';
import { ModelError,type BudgetAccount } from './provider.js';
interface Reservation {id:number;maximumUsd:number;actualUsd?:number}
type BudgetProvider='nebius'|'typesafe';
interface Journal {provider:BudgetProvider;currency:'USD';hardTaskLimit:number;reservedWorstCase:number;observedSpend:number;requests:Reservation[];exhausted?:boolean;maximumCalls?:number}
const units=(n:number)=>Math.round(n*1e9);
export class FileCallBudget implements BudgetAccount {
  constructor(private path:string,private expectedProvider:BudgetProvider='nebius'){
    if(!['nebius','typesafe'].includes(expectedProvider))throw new ModelError('INVALID_BUDGET');
    // Creation is deliberately not automatic: re-pointing at a missing/new file
    // must not silently reset an existing task's spending ceiling.
    this.read();
  }
  private read():Journal{
    try{
      const stat=lstatSync(this.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw new Error();
      const d=JSON.parse(readFileSync(this.path,'utf8')) as Journal;
      if(d.provider!==this.expectedProvider||d.currency!=='USD'||!Number.isFinite(d.hardTaskLimit)||d.hardTaskLimit<=0||d.hardTaskLimit>25||![d.reservedWorstCase,d.observedSpend].every(n=>Number.isFinite(n)&&n>=0)||!Array.isArray(d.requests)||d.requests.length>2000||units(d.reservedWorstCase+d.observedSpend)>Math.floor(d.hardTaskLimit*1e9))throw new Error();
      if(d.maximumCalls!==undefined&&(!Number.isSafeInteger(d.maximumCalls)||d.maximumCalls<1||d.maximumCalls>2000||d.requests.length>d.maximumCalls))throw new Error();
      const ids=new Set<number>();let reserved=0,spent=0;
      for(const r of d.requests){if(!Number.isSafeInteger(r.id)||r.id<1||r.id>2000||ids.has(r.id)||!Number.isFinite(r.maximumUsd)||r.maximumUsd<0||r.actualUsd!==undefined&&(!Number.isFinite(r.actualUsd)||r.actualUsd<0||units(r.actualUsd)>units(r.maximumUsd)))throw new Error();ids.add(r.id);if(r.actualUsd===undefined)reserved+=units(r.maximumUsd);else spent+=units(r.actualUsd);}
      if(reserved!==units(d.reservedWorstCase)||spent!==units(d.observedSpend))throw new Error();return d;
    }catch{throw new ModelError('INVALID_BUDGET');}
  }
  private change<T>(action:(d:Journal)=>T):T{
    let lock:number;try{lock=openSync(this.path+'.lock','wx',0o600);}catch{throw new ModelError('BUDGET_DENIED');}
    try{
      const d=this.read(),result=action(d),bytes=Buffer.from(JSON.stringify(d,null,2)+'\n');
      // Keep the existing inode: file fsync is portable; directory fsync after
      // rename is not supported on Windows. A torn write is INVALID_BUDGET,
      // never a reason to create/reset a journal or resume spending.
      const file=openSync(this.path,'r+');try{writeFileSync(file,bytes);ftruncateSync(file,bytes.length);fsyncSync(file);}finally{closeSync(file);}
      return result;
    }finally{closeSync(lock);unlinkSync(this.path+'.lock');}
  }
  reserve(usd:number,maximumCalls=2000){return this.change(d=>{
    const value=Math.ceil(usd*1e9);if(!Number.isSafeInteger(maximumCalls)||maximumCalls<1||maximumCalls>2000||d.exhausted||!Number.isSafeInteger(value)||value<0||d.requests.length>=Math.min(maximumCalls,d.maximumCalls??100)||units(d.reservedWorstCase)+units(d.observedSpend)+value>Math.floor(d.hardTaskLimit*1e9))throw new ModelError('BUDGET_DENIED');
    const id=Math.max(0,...d.requests.map(r=>r.id))+1;d.reservedWorstCase=(units(d.reservedWorstCase)+value)/1e9;d.requests.push({id,maximumUsd:value/1e9});return id;
  });}
  settle(id:number,usd:number){
    let invalid=false;this.change(d=>{const r=d.requests.find(r=>r.id===id),value=Math.ceil(usd*1e9);
      if(!r||r.actualUsd!==undefined||!Number.isSafeInteger(value)||value<0||value>units(r.maximumUsd)){d.exhausted=true;invalid=true;return;}
      d.reservedWorstCase=(units(d.reservedWorstCase)-units(r.maximumUsd))/1e9;d.observedSpend=(units(d.observedSpend)+value)/1e9;r.actualUsd=value/1e9;
    });if(invalid)throw new ModelError('BUDGET_ACCOUNTING_ERROR');
  }
  /** Add durable task admission around this SAME journal. The facade cannot replace
   * cumulative reservation/settlement with another ledger or reset its ceiling.
   * Failed global admission conservatively retains the task's beforeReserve charge. */
  withCaps(caps:{beforeReserve(usd:number):void;afterReserve(id:number,usd:number):void;afterSettle(id:number,usd:number):void}):FileCallBudget {
    const global=this,path=this.path;
    return new class extends FileCallBudget {
      constructor(){super(path);}
      override reserve(usd:number){caps.beforeReserve(usd);const id=global.reserve(usd);caps.afterReserve(id,usd);return id;}
      override settle(id:number,usd:number){global.settle(id,usd);caps.afterSettle(id,usd);}
      override stop(){global.stop();}
      override snapshot(){return global.snapshot();}
    }();
  }
  stop(){this.change(d=>{d.exhausted=true;});}
  snapshot(){const d=this.read();return {limitUsd:d.hardTaskLimit,accountedUsd:(units(d.reservedWorstCase)+units(d.observedSpend))/1e9,calls:d.requests.length,exhausted:!!d.exhausted||d.maximumCalls!==undefined&&d.requests.length>=d.maximumCalls};}
}
