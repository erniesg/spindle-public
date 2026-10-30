import { EvidenceStore } from './store.js';
import type { ToolContext } from '../agent/contracts.js';
/** Infrastructure faults are not ordinary unsupported-input/provider outcomes. */
export function isEvidenceStoreFault(error:unknown):boolean {
 const code=(error as NodeJS.ErrnoException|null)?.code;
 return typeof code==='string'&&(code.startsWith('ERR_SQLITE')||['ERR_INVALID_STATE','EIO','ENOSPC','EROFS','EACCES','EPERM','EMFILE','ENFILE'].includes(code));
}
/** Resolve an opaque source/artifact through bounded lineage to exact currently granted roots. */
export function resolveInput(store:EvidenceStore, ctx:Pick<ToolContext,'workspaceId'|'accountId'>&{scope:Pick<ToolContext['scope'],'sources'>}, id:string) {
 const ns={workspaceId:ctx.workspaceId,accountId:ctx.accountId};
 // Provider file IDs are aliases ONLY for already-admitted current scoped bytes.
 // Never download, search another task/namespace, or guess a snapshot from an ID.
 if(!ctx.scope.sources.some(s=>s.id===id||s.snapshotArtifactId===id)){
  let directArtifact=false;try{store.artifact(ns,id);directArtifact=true;}catch(error){if(isEvidenceStoreFault(error))throw error;}
  if(!directArtifact){const refs=ctx.scope.sources.filter(s=>s.provider==='drive'&&s.providerVersion!=='observed-listing'&&s.providerId===id);if(refs.length){if(new Set(refs.map(s=>s.providerVersion+':'+s.sha256)).size!==1)throw new Error('Provider input reference is ambiguous; use an exact scoped artifact/source ID');id=refs[0].snapshotArtifactId;}}
 }
 let visits=0; const active=new Set<string>(); const roots=new Map<string,string>();
 function walk(key:string):void {
  if(++visits>64 || active.has(key)) throw new Error('Input lineage exceeds bounds');
  active.add(key);
  try {
   const root=ctx.scope.sources.find(s=>s.id===key || s.snapshotArtifactId===key);
   if(root) {
    const source=store.source(ns,root.id), artifact=store.artifact(ns,source.snapshotArtifactId);
    if(source.accountId!==ctx.accountId || source.sha256!==root.sha256 || source.snapshotArtifactId!==root.snapshotArtifactId || artifact.sha256!==root.sha256) throw new Error('Granted source changed');
    roots.set(source.id,source.sha256); return;
   }
   const artifact=store.artifact(ns,key);
   if(!artifact.derivedFrom.length) throw new Error('No granted source root');
   for(const parent of artifact.derivedFrom) walk(parent);
  } finally { active.delete(key); }
 }
 walk(id);
 const root=ctx.scope.sources.find(s=>s.id===id);
 const artifact=store.artifact(ns,root?root.snapshotArtifactId:id);
 // Camera originals (e.g. 20MP JPEG ~12MB); matches the image worker's 24MB decode bound.
 if(artifact.bytes>24*1024*1024) throw new Error('Image input too large');
 return {artifact,bytes:store.read(ns,artifact.id,24*1024*1024),namespace:ns,roots};
}
