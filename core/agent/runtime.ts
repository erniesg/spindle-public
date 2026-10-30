import { randomUUID } from 'node:crypto';
import { AgentStore } from '../storage/agent-store.js';
import type { AgentProvider, ChecklistItem, Decision, Task, ToolDefinition, ToolResult, RunOptions } from './contracts.js';

export class AgentRuntime {
 private active = new Map<string, AbortController>();
 cancel(id: string): void { this.store.cancel(id); this.active.get(id)?.abort(); }
 private tools = new Map<string,ToolDefinition>();
 constructor(private store: AgentStore, tools: ToolDefinition[]) {
  for (const tool of tools) {if(this.tools.has(tool.name)) throw new Error('Duplicate tool'); this.tools.set(tool.name,tool);}
 }
 async run(id: string, provider: AgentProvider, maxTurns: number, options: RunOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('Invalid turn bound');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid timeout');
  const initial = this.store.get(id);
  if(initial.pending) throw new Error('Recover interrupted run before resuming');
  if(initial.status !== 'working' || initial.recovery !== 'clean') return;
  this.active.get(id)?.abort();
  const controller = new AbortController();
  // Repetition guard (per run): identical calls that already failed, or already succeeded twice, are not re-run.
  const history=new Map<string,{fails:number;oks:number;lastError?:string;transientRetried?:boolean}>();
  const keyOf=(name:string,args:unknown)=>name+' '+JSON.stringify(args);
  const refusals=new Map<string,number>();
  const repeated=(name:string,args:unknown)=>{const k=keyOf(name,args),h=history.get(k);if(!h)return undefined;
   // A model that keeps re-sending a refused call is stuck: stop instead of spending the whole decision budget.
   const n=(refusals.get(k)??0)+1;refusals.set(k,n);if(n>2)throw new Error(`Stopped: ${name} was re-sent unchanged ${n+1} times after failing or completing; adjust the request or inputs and Resume.`);if(h.fails>0)return `This exact ${name} call already failed (${(h.lastError??'').slice(0,160)}); change the arguments, the input, or the approach.`;if(h.oks>=2)return `This exact ${name} call already succeeded twice; use its earlier result instead of repeating it.`;return undefined;};
  const remember=(name:string,args:unknown,result:{status:string;error?:{message:string}})=>{const k=keyOf(name,args),h=history.get(k)??{fails:0,oks:0};// A lost credential compare-and-set is transient: allow one identical retry before it counts.
   if(result.status==='ok')h.oks++;else if(/Connection changed: retry/.test(result.error?.message??'')&&!h.transientRetried)h.transientRetried=true;else{h.fails++;h.lastError=result.error?.message;}history.set(k,h);};
  this.active.set(id, controller);
  const abort = () => {
   if(this.active.get(id)!==controller) return;
   this.store.cancel(id);
   controller.abort();
  };
  const signalAbort=()=>{if(options.signalMode==='supersede')controller.abort();else abort();};
  options.signal?.addEventListener('abort', signalAbort, {once:true});
  const timer = setTimeout(abort, timeoutMs);
  const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve,reject)=>{
   const stop=()=>reject(new Error('Run cancelled'));
   // The operation may already have cancelled this run synchronously. Always
   // consume its settlement, even when cancellation wins before subscription.
   operation.then(
    value=>{controller.signal.removeEventListener('abort',stop);resolve(value);},
    error=>{controller.signal.removeEventListener('abort',stop);reject(error);}
   );
   if(controller.signal.aborted){stop();return;}
   controller.signal.addEventListener('abort',stop,{once:true});
  });
  const token = randomUUID();
  const claimed = this.store.update(id,t=>{t.generation++; t.run.id=token; t.run.attempt++;});
  const generation = claimed.generation;
  const applicationRevision = JSON.stringify(claimed.applicationRevision);
  const matches = (t:Task) => t.generation===generation && t.run.id===token && t.status==='working' && JSON.stringify(t.applicationRevision)===applicationRevision;
  const current = () => !controller.signal.aborted && matches(this.store.get(id));
  const mutate = (fn:(t:Task)=>void) => this.store.update(id,t=>{if(!matches(t)) throw new Error('Stale run');fn(t);});
  const reserve = () => mutate(t=>{if(t.budget.used>=t.budget.limit) throw new Error('Budget exhausted');t.budget.used++;});
  try {
   if(options.signal?.aborted) signalAbort();
   for(let turn=0;turn<maxTurns && current();turn++) {
    reserve();
    const before = this.store.get(id);
    const decision = await bounded(provider.next(structuredClone(before), [...this.tools.values()].map(({name,version,effect,capabilities,inputSchema,outputSchema})=>({name,version,effect,capabilities,inputSchema:structuredClone(inputSchema.jsonSchema),outputSchema:structuredClone(outputSchema.jsonSchema)})),{signal:controller.signal,isCurrent:current,budget:structuredClone(before.budget)}));
    if(!current()) return;
    // Check decision envelopes even when a provider adapter is faulty.
    if(!decision || !['tool','batch','checklist','ready'].includes(decision.kind)) throw new Error('Invalid decision');
    // Feedback loops are bounded: three identical feedback failures in a row end the run like any other blocker.
    const feedbackStreak=(code:string)=>{let n=0;for(const o of [...before.observations].reverse()){if(o.error?.code===code&&o.error.producer==='runtime')n++;else break;}if(n>=2)throw new Error(`Repeated ${code}`);};
    if(decision.kind==='checklist') {
     this.validateChecklist(decision);
     // Consecutive checklist rewrites make no progress; acknowledge each one so the model moves on to a tool.
     const streak=[...before.decisions].reverse().findIndex(d=>d.kind!=='checklist'),repeated=(streak<0?before.decisions.length:streak)>=2;
     const ack=`checklist-${before.run.cursor}`;
     mutate(t=>{if(!repeated){t.checklistHistory.push(t.checklist);t.checklist={revision:t.checklist.revision+1,reason:decision.reason,items:structuredClone(decision.items)};}t.decisions.push(decision);
      t.observations.push({callId:ack,status:repeated?'failed':'ok',data:null,artifacts:[],evidence:[],observations:[repeated?'Checklist not changed: it was already set. Your next decision must call a registered tool (or declare ready).':'Checklist saved. Continue with the next registered tool call.'],...(repeated?{error:{code:'CHECKLIST_REPEATED',message:'Call a tool next',producer:'runtime'}}:{})});
      t.run.cursor++;}); continue;
    }
    if(decision.kind==='ready') {if(typeof decision.result!=='string') throw new Error('Invalid result');
     // A premature "ready" is feedback for the model (e.g. a required export is missing), not the end of the task.
     try{options.assertReady?.(this.store.get(id));}catch(error){feedbackStreak('READY_REJECTED');const message=(error instanceof Error?error.message:String(error)).slice(0,500),callId=`ready-check-${before.run.cursor}`;
      mutate(t=>{t.decisions.push(decision);t.observations.push({callId,status:'failed',data:null,artifacts:[],evidence:[],observations:['Not ready yet: '+message+' Do that, then declare ready again.'],error:{code:'READY_REJECTED',message,producer:'runtime'}});t.run.cursor++;t.nextAction='Choose next action from observation';});continue;}mutate(t=>{t.status='ready';t.currentResult=decision.result;t.nextAction='Review prepared result';t.decisions.push(decision);});return;}
    {
     // Unknown tools and arguments that fail a tool's schema are feedback, never executed. In a batch the
     // valid calls still run (e.g. a read whose result a dependent call needed); only the bad calls are refused.
     const list=(decision.kind==='batch'&&Array.isArray(decision.calls)?decision.calls:decision.kind==='tool'?[decision]:[]) as {callId?:string;name:unknown;args:unknown}[];
     const problem=(c:{name:unknown;args:unknown})=>{if(typeof c?.name!=='string'||!this.tools.has(c.name))return {code:'UNREGISTERED_TOOL',message:`Not a registered tool: ${String(c?.name)}. Use only registered tools: ${[...this.tools.keys()].join(', ')}.`};
      try{this.tools.get(c.name)!.inputSchema.parse(c.args);return undefined;}catch(error){return {code:'INVALID_TOOL_ARGUMENTS',message:`Invalid arguments for ${c.name}, it was not run: ${(error instanceof Error?error.message:String(error)).slice(0,200)}. Inputs such as inputId must be artifact IDs from earlier results; call a dependent tool in a later turn.`};}};
     const bad=list.map(c=>({c,p:problem(c)})).filter(x=>x.p) as {c:{callId?:string;name:unknown};p:{code:string;message:string}}[];
     if(bad.length){
      const good=list.filter(c=>!problem(c));
      if(!good.length)feedbackStreak(bad[0]!.p.code);
      mutate(t=>{if(!good.length)t.decisions.push(decision);for(const [i,{c,p}] of bad.entries())t.observations.push({callId:`${p.code==='UNREGISTERED_TOOL'?'unknown-tool':'invalid-args'}-${before.run.cursor}${i?'-'+i:''}`,status:'failed',data:null,artifacts:[],evidence:[],observations:[(c.callId?`${c.callId}: `:'')+p.message],error:{code:p.code,message:p.message.slice(0,500),producer:'runtime'}});if(!good.length){t.run.cursor++;t.nextAction='Choose next action from observation';}});
      if(!good.length)continue;
      (decision as Extract<Decision,{kind:'batch'}>).calls=good as Extract<Decision,{kind:'batch'}>['calls'];
     }
    }
    if(decision.kind==='batch') {
     if(!Array.isArray(decision.calls) || decision.calls.length<1 || decision.calls.length>4) throw new Error('Invalid batch bound');
     const ids=new Set<string>();
     // Call IDs are model-chosen labels. A reused or empty label gets a fresh one instead of ending the task.
     const used=(callId:string)=>before.observations.some(o=>o.callId===callId)||before.decisions.some(d=>d.kind==='batch'&&d.calls.some(c=>c.callId===callId));
     const relabelled=new Set<string>();
     for(const call of decision.calls)if(call&&typeof call==='object'){
      const base=typeof call.callId==='string'&&call.callId.trim()?call.callId.trim().slice(0,100):'call';
      if(base!==call.callId||used(base)||relabelled.has(base)){let next=base;for(let n=2;used(next)||relabelled.has(next);n++)next=`${base}-${n}`;call.callId=next;}
      relabelled.add(call.callId);
     }
     const calls=decision.calls.map(call=>{
      // Call IDs are model labels: one reused from an earlier step is made unique; duplicates within one batch are still refused.
      if(call && typeof call.callId==='string' && call.callId.trim() && (before.observations.some(o=>o.callId===call.callId) || before.decisions.some(d=>d.kind==='batch' && d.calls.some(c=>c.callId===call.callId)))) call.callId=`${call.callId.slice(0,100)}~${before.run.cursor}`;
      if(!call || typeof call.callId!=='string' || !call.callId.trim() || call.callId.length>128 || ids.has(call.callId) || before.observations.some(o=>o.callId===call.callId) || before.decisions.some(d=>d.kind==='batch' && d.calls.some(c=>c.callId===call.callId))) throw new Error('Duplicate or invalid call ID');
      ids.add(call.callId);
      const tool=this.tools.get(call.name);
      if(!tool) throw new Error('Unregistered tool');
      if(tool.effect==='external_write' && !options.approveExternalWrite?.(this.store.get(id),tool,call.args)) throw new Error('External effects are not authorised by this runtime');
      if(call.itemId) {
       const item=before.checklist.items.find(i=>i.id===call.itemId);
       if(!item || item.state==='blocked' || item.dependsOn.some(dep=>!['done','skipped'].includes(before.checklist.items.find(i=>i.id===dep)?.state??''))) throw new Error('Checklist dependency blocked');
      }
      const again=repeated(call.name,call.args);if(again)return {call,tool,args:undefined,invalid:again,code:'REPEATED_CALL'};
      try{return {call,tool,args:tool.inputSchema.parse(call.args)};}catch(error){return {call,tool,args:undefined,invalid:error instanceof Error?error.message:'Invalid arguments'};}
     });
     // Invalid arguments have no effect: record them for the model to correct; run nothing from this batch.
     if(calls.some(c=>'invalid' in c)){mutate(t=>{t.decisions.push(structuredClone(decision));t.observations.push(...calls.map(c=>this.rejected(c.call.callId,c.tool.name,'invalid' in c?c.invalid!:undefined,'code' in c&&c.code?c.code:undefined)));t.run.cursor++;t.nextAction='Choose next action from observations';});continue;}
     const writes=calls.some(({tool})=>tool.effect!=='read');
     // Reserve the whole batch atomically before any invocation. The existing
     // pending fence covers the entire batch; an interrupted write is uncertain.
     mutate(t=>{
      if(t.budget.limit-t.budget.used<calls.length) throw new Error('Budget exhausted');
      t.budget.used+=calls.length;
      t.pending={callId:randomUUID(),tool:'batch',effect:calls.some(({tool})=>tool.effect==='external_write')?'external_write':writes?'write_local':'read'};
      t.decisions.push(structuredClone(decision));t.nextAction='Observe tool batch';
     });
     let uncertainWrite=false;
     const invoke=async ({call,tool,args}:typeof calls[number]):Promise<ToolResult>=>{
      if(!current()) throw new Error('Run cancelled');
      if(tool.effect==='external_write' && !options.approveExternalWrite?.(this.store.get(id),tool,args)) throw new Error('External approval changed');
      try {
       const data=await bounded(tool.invoke(args,{callId:call.callId,scope:structuredClone(options.getScope?.()??options.scope??{sources:[],destinations:[],grants:[]}),budget:structuredClone(this.store.get(id).budget),taskId:id,runId:token,accountId:before.sourceEvent.accountId,workspaceId:before.sourceEvent.workspaceId,applicationRevision:before.applicationRevision,signal:controller.signal,isCurrent:current}));
       const result=this.validateResult(data,call.callId);
       result.data=tool.outputSchema.parse(result.data);
       if(tool.effect!=='read'&&result.status!=='ok'&&result.effect!=='none')uncertainWrite=true;
       return result;
      } catch(error) {
       if(tool.effect!=='read')uncertainWrite=true;
       return {callId:call.callId,status:'failed',data:null,artifacts:[],evidence:[],observations:[],error:{code:'TOOL_FAILED',message:error instanceof Error?error.message:'Tool failed',producer:tool.name}};
      }
     };
     const results:ToolResult[]=[];
     // No declared dependency graph is inferred from model text. Only pure read
     // batches without checklist bindings overlap; all other batches serialize.
     if(!writes && calls.every(({call})=>!call.itemId)) results.push(...await Promise.all(calls.map(invoke)));
     else for(const call of calls) {
      if(writes && results.some(r=>r.status!=='ok')) results.push({callId:call.call.callId,status:'failed',data:null,artifacts:[],evidence:[],observations:[],error:{code:'DEPENDENCY_NOT_RUN',message:'Earlier batch operation did not succeed; not run. Call it again in a later turn with real artifact IDs from earlier results.',producer:call.tool.name}});
      else results.push(await invoke(call));
      if(!current()) return;
     }
     if(!current()) return;
     results.forEach((r,i)=>{const c=calls[i];if(c&&r.error?.code!=='DEPENDENCY_NOT_RUN')remember(c.call.name,c.call.args,r);});
     mutate(t=>{t.observations.push(...results);if(!uncertainWrite)delete t.pending;t.run.cursor++;t.nextAction='Choose next action from observations';// A batch whose failures are all proven no-effect is an ordinary observation the model can correct; only unknown effects block.
      if(writes && results.some(r=>r.status!=='ok') && uncertainWrite){t.status='blocked';if(uncertainWrite)t.recovery='reconciliation_required';t.blocker=uncertainWrite?'Unknown batch write effects need reconciliation':'Batch operation refused without unknown effects';}});
     continue;
    }
    const tool = this.tools.get(decision.name);
    if(!tool) throw new Error('Unregistered tool');
    // No generic write authority: only a trusted revision/argument-bound host policy can admit it.
    if(tool.effect==='external_write' && !options.approveExternalWrite?.(this.store.get(id),tool,decision.args)) throw new Error('External effects are not authorised by this runtime');
    if(decision.itemId) {
     const item = before.checklist.items.find(i=>i.id===decision.itemId);
     if(!item || item.state==='blocked' || item.dependsOn.some(dep=>!['done','skipped'].includes(before.checklist.items.find(i=>i.id===dep)?.state??''))) throw new Error('Checklist dependency blocked');
    }
    let args:unknown;
    const again=repeated(tool.name,decision.args);if(again){mutate(t=>{t.decisions.push(decision);t.observations.push(this.rejected(randomUUID(),tool.name,again,'REPEATED_CALL'));t.run.cursor++;t.nextAction='Choose next action from observation';});continue;}
    try{args=tool.inputSchema.parse(decision.args);}catch(error){const message=error instanceof Error?error.message:'Invalid arguments';mutate(t=>{t.decisions.push(decision);t.observations.push(this.rejected(randomUUID(),tool.name,message));t.run.cursor++;t.nextAction='Choose next action from observation';});continue;}
    reserve(); const callId=randomUUID();
    mutate(t=>{t.pending={callId,tool:tool.name,effect:tool.effect};t.decisions.push(decision);t.nextAction=`Observe ${tool.name}`;});
    const revision = JSON.stringify(before.applicationRevision);
    const data = await bounded(tool.invoke(args,{callId,scope:structuredClone(options.getScope?.() ?? options.scope ?? {sources:[],destinations:[],grants:[]}),budget:structuredClone(this.store.get(id).budget),taskId:id,runId:token,accountId:before.sourceEvent.accountId,workspaceId:before.sourceEvent.workspaceId,applicationRevision:before.applicationRevision,signal:controller.signal,isCurrent:current}));
    if(!current()) return;
    if(JSON.stringify(this.store.get(id).applicationRevision)!==revision) throw new Error('Stale application revision');
    const validated = this.validateResult(data, callId);
    validated.data = tool.outputSchema.parse(validated.data);
    remember(tool.name,decision.args,validated);
    mutate(t=>{t.observations.push(validated);delete t.pending;t.run.cursor++;t.nextAction='Choose next action from observation';});
   }
   if(options.blockOnTurnLimit&&current())mutate(t=>{t.status='blocked';t.blocker='Agent turn bound reached';t.nextAction='Review retained observations and effects before explicit continuation';if(t.pending&&t.pending.effect!=='read')t.recovery='reconciliation_required';});
  } catch(error) {
   if(current()) mutate(t=>{t.status='blocked';t.blocker=error instanceof Error?error.message:'Tool failed';t.nextAction='Resolve blocker and recover task';if(t.pending && t.pending.effect!=='read')t.recovery='reconciliation_required';});
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',signalAbort); if(this.active.get(id)===controller)this.active.delete(id); }
 }
 /** No-effect observation for arguments rejected before invocation (or a batch sibling that was therefore not run). */
 private rejected(callId:string,producer:string,message?:string,code='TOOL_ARGUMENTS_INVALID'):ToolResult {
  return message===undefined
   ?{effect:'none',callId,status:'failed',data:null,artifacts:[],evidence:[],observations:['Not run: another call in this batch had invalid arguments.'],error:{code:'DEPENDENCY_NOT_RUN',message:'Batch sibling had invalid arguments',producer}}
   :{effect:'none',callId,status:'failed',data:null,artifacts:[],evidence:[],observations:[code==='READY_REQUIREMENTS_UNMET'?'Ready was not accepted; nothing changed. Complete the stated requirement, then declare ready again.':'Arguments rejected before invocation; no effect. Correct them and retry.'],error:{code,message:message.slice(0,500)||'Invalid arguments',producer}};
 }
 private validateResult(result: ToolResult, callId: string): ToolResult {
  const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string');
  if(!result || result.callId!==callId || !['ok','needs_input','failed'].includes(result.status) || !strings(result.observations) || !Array.isArray(result.artifacts) || !Array.isArray(result.evidence)) throw new Error('Invalid tool result');
  if(result.effect!==undefined&&(result.effect!=='none'||result.status==='ok'||result.artifacts.length))throw new Error('Invalid no-effect result');
  for(const a of result.artifacts) if(!a || typeof a.id!=='string' || typeof a.mimeType!=='string' || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes<0 || typeof a.relativePath!=='string' || typeof a.createdAt!=='string' || !strings(a.derivedFrom) || !Number.isSafeInteger(a.version)) throw new Error('Invalid artifact');
  for(const e of result.evidence) if(!e || ![e.id,e.sourceId,e.sourceVersion,e.artifactId].every(x=>typeof x==='string'&&x.length>0) || (e.spanIds!==undefined&&!strings(e.spanIds))) throw new Error('Invalid evidence');
  if((result.status==='failed'&&!result.error) || (result.error && ![result.error.code,result.error.message,result.error.producer].every(x=>typeof x==='string'&&x.length>0))) throw new Error('Invalid tool error');
  return structuredClone(result);
 }
 private validateChecklist(decision: Extract<Decision,{kind:'checklist'}>): void {
  if(typeof decision.reason!=='string' || !decision.reason.trim() || !Array.isArray(decision.items) || decision.items.length>100) throw new Error('Invalid checklist');
  // Models routinely omit empty dependencies; treat a missing list as none rather than blocking the task.
  const synonyms:Record<string,ChecklistItem['state']>={completed:'done',complete:'done',finished:'done','in-progress':'in_progress',inprogress:'in_progress',todo:'pending',not_started:'pending',failed:'blocked',error:'blocked',cancelled:'skipped',canceled:'skipped'};
  for(const item of decision.items)if(item&&typeof item==='object'){if(item.dependsOn===undefined)item.dependsOn=[];const state=synonyms[String(item.state).toLowerCase()];if(state)item.state=state;}
  const ids=new Set(decision.items.map(i=>i.id));
  if(ids.size!==decision.items.length) throw new Error('Duplicate checklist item');
  // A replacement checklist may still name items from the list it replaces; those are finished history, not blockers.
  for(const item of decision.items)if(item&&Array.isArray(item.dependsOn))item.dependsOn=item.dependsOn.filter(dep=>ids.has(dep));
  const visit=(item:ChecklistItem,path:Set<string>):void=>{
   if(path.has(item.id))throw new Error('Cyclic checklist');
   if(typeof item.title!=='string' || !['pending','in_progress','blocked','done','skipped'].includes(item.state) || !Array.isArray(item.dependsOn))throw new Error('Invalid checklist item');
   for(const dep of item.dependsOn){const parent=decision.items.find(i=>i.id===dep);if(!parent)throw new Error('Missing dependency');visit(parent,new Set([...path,item.id]));}
  };
  for(const item of decision.items)visit(item,new Set());
 }
}
