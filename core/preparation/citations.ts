import type {Task} from '../agent/contracts.js';
import type {EvidenceStore,Namespace} from '../evidence/store.js';
import {isEvidenceStoreFault} from '../evidence/inputs.js';
import {resolveOcr} from '../evidence/ocr.js';
import type {PreparationCitation} from './types.js';
/** Review uses already-persisted local region PNGs when available. Never draw encoded
 * EXIF/HEIF coordinates over an implicitly browser-oriented/undecodable source. */
export function preparationCitation(store:EvidenceStore,ns:Namespace,task:Task,citation:PreparationCitation){
 try{
  const a=store.artifact(ns,citation.artifactId);if(a.mimeType!=='application/vnd.spindle.ocr+json')return {...citation,previewArtifactId:citation.artifactId};
  const spans=resolveOcr(store,ns,citation.artifactId,citation.sourceId,citation.sourceVersion,citation.spanIds??[]);
  for(const observation of [...task.observations].reverse()){
   const data=observation.data as {kind?:string;ocrArtifactId?:string;inputArtifactId?:string;inputHash?:string;outputId?:string;outputHash?:string;regions?:{spanId:string}[]};
   if(observation.status!=='ok'||data?.kind!=='spindle.ocr.regions.v1'||data.ocrArtifactId!==citation.artifactId||!data.outputId||!task.preparation?.artifactIds.includes(data.outputId)||!spans.every(s=>data.regions?.some(r=>r.spanId===s.spanId)))continue;
   const preview=store.artifact(ns,data.outputId);if(preview.mimeType!=='image/png'||preview.sha256!==data.outputHash||data.inputArtifactId!==spans[0]?.snapshotArtifactId||data.inputHash!==spans[0]?.imageHash)continue;
   return {...citation,previewArtifactId:preview.id,regionPreview:true,coordinateProvenance:spans[0]?.coordinateProvenance,regions:spans.map(s=>s.polygon)};
  }
  return {...citation,previewArtifactId:spans[0]?.snapshotArtifactId,regionPreview:false,coordinateProvenance:spans[0]?.coordinateProvenance,regions:spans.map(s=>s.polygon)};
 }catch(error){if(isEvidenceStoreFault(error))throw error;return {...citation,previewUnavailable:true};}
}
