import type {BudgetAccount} from '../models/provider.js';
import {FileCallBudget} from '../models/file-budget.js';
import type {AgentStore} from '../storage/agent-store.js';
export function preparationBudget(tasks:AgentStore,taskId:string,global:FileCallBudget,kind:'decision'|'vision'):FileCallBudget;
export function preparationBudget(tasks:AgentStore,taskId:string,global:BudgetAccount,kind:'decision'|'vision'):BudgetAccount;
/** Per-task conservative cap composed with the EXISTING cumulative budget. No journal creation/reset.
 * Reservations and call counts survive restart; unknown calls retain their full charge. */
export function preparationBudget(tasks:AgentStore,taskId:string,global:BudgetAccount,kind:'decision'|'vision'):BudgetAccount {
 const held=new Map<number,number>();
 const beforeReserve=(usd:number)=>{
  if(!Number.isFinite(usd)||usd<0)throw Error('INVALID_TASK_RESERVATION');
  const units=Math.ceil(usd*1e9)/1e9;
  tasks.update(taskId,t=>{const p=t.preparation;if(!p||!p.processingConsent||t.status!=='working')throw Error('PREPARATION_NOT_CURRENT');const b=p.modelBudget,key=kind==='decision'?'decisionCalls':'visionCalls',max=kind==='decision'?b.maximumDecisionCalls:b.maximumVisionCalls;if(b[key]>=max||Math.ceil((b.reservedUsd+units)*1e9)>Math.floor(b.limitUsd*1e9))throw Error('TASK_MODEL_BUDGET_DENIED');b[key]++;b.reservedUsd=Math.ceil((b.reservedUsd+units)*1e9)/1e9;});
 };
 const afterReserve=(id:number,usd:number)=>{held.set(id,Math.ceil(usd*1e9)/1e9);};
 const afterSettle=(id:number,usd:number)=>{const amount=held.get(id);if(amount===undefined||!Number.isFinite(usd)||usd<0||usd>amount){global.stop();throw Error('TASK_BUDGET_ACCOUNTING_ERROR');}held.delete(id);tasks.update(taskId,t=>{const b=t.preparation!.modelBudget;b.reservedUsd=Math.max(0,Math.ceil((b.reservedUsd-amount+usd)*1e9)/1e9);});};
 // Preserve the actual durable FileCallBudget contract required by vision/OCR factories,
 // while retaining all global enforcement. This is a scoped view of the SAME journal.
 if(global instanceof FileCallBudget)return global.withCaps({beforeReserve,afterReserve,afterSettle});
 return {
  reserve(usd){beforeReserve(usd);const id=global.reserve(usd);afterReserve(id,usd);return id;},
  settle(id,usd){global.settle(id,usd);afterSettle(id,usd);},stop(){global.stop();},
  snapshot(){const b=tasks.get(taskId).preparation!.modelBudget;return {limitUsd:b.limitUsd,accountedUsd:b.reservedUsd,calls:b.decisionCalls+b.visionCalls,exhausted:b.reservedUsd>=b.limitUsd};}
 };
}
