// Trusted local operator configuration, never an HTTP/model-selected path.
import { lstatSync,readFileSync } from 'node:fs';
import { FileCallBudget } from './file-budget.js';
import { TextProvider,ModelError,type ModelDeclaration } from './provider.js';
export function configuredNebius(path:string){
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new ModelError('INVALID_MODEL');
  const value:unknown=JSON.parse(readFileSync(path,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ModelError('INVALID_MODEL');
  const c=value as Record<string,unknown>;
  if(Object.keys(c).sort().join(',')!=='budgetPath,model'||typeof c.budgetPath!=='string'||!c.model||typeof c.model!=='object'||Array.isArray(c.model))throw new ModelError('INVALID_MODEL');
  const model=c.model as ModelDeclaration;
  if(model.provider!=='nebius'||Object.keys(model).some(k=>!['provider','id','text','jsonObject','inputContextTokens','maxOutputTokens','jsonSchema','images','pricing'].includes(k)))throw new ModelError('INVALID_MODEL');
  return new TextProvider(model,new FileCallBudget(c.budgetPath),async()=>process.env.NEBIUS_API_KEY??'');
}
