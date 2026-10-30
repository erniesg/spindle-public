// Host-only, explicitly selected operator configuration. Never imported by the
// extension or selected through IPC. No automatic key/journal discovery/creation.
import {lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {parseEnv} from 'node:util';
import {FileCallBudget} from '../models/file-budget.js';
import {PurposeClassifier} from '../blocking/classifier.js';
function privateFile(path:string,maximum:number){
 const info=lstatSync(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>maximum||process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('PURPOSE_CONFIGURATION_UNAVAILABLE');
}
export function configuredPurpose(path=process.env.SPINDLE_PURPOSE_CONFIG):PurposeClassifier|undefined{
 if(!path)return;
 try{
  if(!isAbsolute(path))throw Error();privateFile(path,8192);
  const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='budgetFile,keyFile,keyFormat,maximumCalls,provider'
   ||data.provider!=='typesafe'||typeof data.keyFormat!=='string'||!['raw','dotenv'].includes(data.keyFormat)||typeof data.keyFile!=='string'||!isAbsolute(data.keyFile)
   ||typeof data.budgetFile!=='string'||!isAbsolute(data.budgetFile)||!Number.isSafeInteger(data.maximumCalls)||Number(data.maximumCalls)<1||Number(data.maximumCalls)>100)throw Error();
  const keyFile=data.keyFile,budget=new FileCallBudget(data.budgetFile,'typesafe');
  // Opening the explicit journal is not spending authority. The classifier
  // checks admission/busy/cumulative calls before this lazy credential read.
  return new PurposeClassifier(budget,async()=>{
   privateFile(keyFile,8192);const text=readFileSync(keyFile,'utf8');
   if(data.keyFormat==='dotenv')return parseEnv(text).TYPESAFE_API_KEY?.trim()??'';
   if(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(text))throw Error('PURPOSE_CREDENTIAL_FORMAT');
   return text.trim();
  },fetch,()=>performance.now(),data.maximumCalls as number);
 }catch{throw Error('PURPOSE_CONFIGURATION_UNAVAILABLE');}
}
export function optionalPurpose():PurposeClassifier|undefined{
 try{return configuredPurpose();}catch{console.error('PURPOSE_CONFIGURATION_UNAVAILABLE: purpose processing stays disabled');return;}
}
