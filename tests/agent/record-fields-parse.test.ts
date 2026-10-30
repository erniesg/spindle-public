import test from 'node:test';
import assert from 'node:assert/strict';
import {preparationTools} from '../../core/preparation/tools.js';
const record=()=>preparationTools({} as never,'build').find(t=>t.name==='preparation.record_fields')!;
const field=(o:Record<string,unknown>={})=>({id:'nric',label:'NRIC',value:'S1',unresolved:false,citations:[],...o});
test('record_fields normalizes whitespace in ids and names the field and reason when refusing',()=>{
 const args={fields:[field({id:' nr ic '})]};const parsed=record().inputSchema.parse(args) as {fields:{id:string}[]};
 assert.equal(parsed.fields[0]!.id,'nr_ic');assert.equal(args.fields[0]!.id,' nr ic ','the model arguments are not mutated (repetition-guard key and transcript stay as sent)');
 assert.throws(()=>record().inputSchema.parse({fields:[field({id:'a.b'})]}),/"a\.b": id must use only letters/);
 assert.throws(()=>record().inputSchema.parse({fields:[field({unresolved:true})]}),/"nric": an unresolved field must have an empty value/);
 assert.throws(()=>record().inputSchema.parse({fields:[field({note:1})]}),/unknown key "note"/);
 assert.throws(()=>record().inputSchema.parse({fields:[field({id:'a b'}),field({id:'a_b'})]}),/unique/);
});
