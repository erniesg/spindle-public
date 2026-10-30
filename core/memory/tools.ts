import type { ToolDefinition, ToolContext, Schema, ToolResult } from '../agent/contracts.js';
import { EvidenceStore } from '../evidence/store.js';
import { MemoryStore } from './store.js';
import { ScopedFilesystem } from '../connectors/filesystem.js';
/** Application-owned opaque selection: neither relative paths nor roots come from the model. */
export interface ContextSelection { rootId: string; path: string; mimeType: string }
const string = { type: 'string', minLength: 1, maxLength: 8192 };
function schema(properties: Record<string, unknown>, required: string[]): Schema {
 return { jsonSchema: {type:'object',properties,required,additionalProperties:false}, parse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !(k in properties)) || required.some(k => !(k in obj))) throw new Error('Unexpected or missing field');
  for (const [key, val] of Object.entries(obj)) {
   const rule = properties[key] as {type:string; enum?: string[]; maxLength?: number};
   if (rule.type === 'array') { if (!Array.isArray(val) || val.length > 100 || val.some(x => typeof x !== 'string' || !x || x.length > 8192)) throw new Error('Invalid references'); }
   else if (typeof val !== rule.type || (typeof val === 'string' && (!val || val.length > (rule.maxLength ?? 8192))) || (rule.enum && !rule.enum.includes(val as string))) throw new Error('Invalid field');
  }
  return obj;
 }};
}
const refs = {type:'array',maxItems:100,items:string};
/** Scope grants are exact tool capability names. Trusted caller owns correction authority. */
export function contextTools(store: EvidenceStore, roots: Record<string,string>, selections: Record<string,ContextSelection>): ToolDefinition[] {
 const files = new ScopedFilesystem(store, roots); const memory = new MemoryStore(store);
 const selected = structuredClone(selections);
 const make = (name: string, inputSchema: Schema, effect: ToolDefinition['effect'], execute: (a:Record<string,unknown>, c:ToolContext) => Partial<ToolResult>): ToolDefinition => ({
  name, version:'1', capabilities:[name], effect, inputSchema,
  outputSchema: {jsonSchema:{type:name==='memory.read' ? ['object','null'] : name==='memory.search' ? 'array' : 'object'},parse: value => {
   if (name==='memory.read' && value===null) return null;
   if (!value || typeof value!=='object' || Array.isArray(value)!==(name==='memory.search')) throw new Error('Invalid output');
   return value;
  }},
  async invoke(args, c) {
   if (c.signal.aborted || !c.isCurrent()) throw new Error('Cancelled context call');
   if (!c.scope.grants.includes(name)) throw new Error('Capability not granted');
   const result = execute(inputSchema.parse(args) as Record<string,unknown>, c);
   return {callId:c.callId,status:'ok',data:null,artifacts:[],evidence:[],observations:[],...result};
  }
 });
 const ns = (c:ToolContext) => ({accountId:c.accountId,workspaceId:c.workspaceId});
 return [
  make('memory.search',schema({query:{...string,maxLength:512}},['query']),'read',(a,c)=>({data:memory.search(ns(c),a.query as string)})),
  make('memory.read',schema({key:string},['key']),'read',(a,c)=>({data:memory.read(ns(c),a.key as string) ?? null})),
  make('memory.record',schema({key:string,kind:{type:'string',enum:['fact','preference','goal']},value:string,sourceIds:refs},['key','kind','value','sourceIds']),'write_local',(a,c)=>{
   const sourceIds = a.sourceIds as string[];
   if (sourceIds.some(id=>!c.scope.sources.some(s=>s.id===id && (!s.accountId || s.accountId===c.accountId)))) throw new Error('Source not permitted');
   return {data:memory.record(ns(c),{key:a.key as string,kind:a.kind as 'fact'|'preference'|'goal',value:a.value as string,sourceIds,userCorrected:false})};
  }),
  make('files.read',schema({selectionId:string},['selectionId']),'read',(a,c)=>{
   const selection = selected[a.selectionId as string];
   if (!selection || !c.scope.grants.includes(`files.root:${selection.rootId}`)) throw new Error('Root not permitted');
   const result = files.read(ns(c),selection.rootId,selection.path,selection.mimeType); const source=result.source!;
   return {data:{source,text:store.read(ns(c),result.artifact.id).toString('utf8')},artifacts:[result.artifact],evidence:[{id:source.id,sourceId:source.id,sourceVersion:source.sha256,artifactId:result.artifact.id}]};
  }),
  make('files.write',schema({text:string,mimeType:string,derivedFrom:refs},['text','mimeType','derivedFrom']),'write_local',(a,c)=>{
   const ids=a.derivedFrom as string[];
   if(ids.some(id=>!c.scope.sources.some(s=>s.id===id && (!s.accountId || s.accountId===c.accountId)))) throw new Error('Source not permitted');
   const artifact=files.write(ns(c),Buffer.from(a.text as string),a.mimeType as string,ids);
   return {data:artifact,artifacts:[artifact]};
  })
 ];
}
