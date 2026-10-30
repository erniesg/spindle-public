import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillTool,preparationSkills} from '../../core/preparation/skills.js';
const ctx={callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a',scope:{sources:[],destinations:[],grants:[]},budget:{used:0,limit:1},signal:new AbortController().signal,isCurrent:()=>true};
test('skill.load is read-only, lists every skill in its schema and returns the versioned playbook',async()=>{
 const tool=createSkillTool();assert.equal(tool.effect,'read');
 const described=JSON.stringify(tool.inputSchema.jsonSchema);for(const s of preparationSkills)assert.ok(described.includes(s.name)&&described.includes(s.summary.slice(0,20)),s.name);
 const r=await tool.invoke(tool.inputSchema.parse({name:'application-photo'}),ctx);
 assert.equal(r.status,'ok');assert.deepEqual(r.artifacts,[]);const d=r.data as {name:string;version:string;instructions:string};
 assert.equal(d.name,'application-photo');assert.match(d.instructions,/image\.fit_photo/);assert.match(d.instructions,/never names, ID numbers/);
 assert.throws(()=>tool.inputSchema.parse({name:'rm -rf'}));assert.throws(()=>tool.inputSchema.parse({name:'fill-form',extra:1}));
});
test('every skill only references registered production tool names',()=>{
 const known=new Set(['image.inspect','image.remove_background','image.retouch','image.text_overlay','image.crop_resize','image.verify','image.fit_photo','document.inspect','document.edit','document.export','document.extract_text','document.overlay','document.render','ocr.document','ocr.render_regions','drive.create_artifact','drive.list','drive.read','session.export','draft.export','preparation.record_fields','web.search','web.open_result','skill.load','document.layout','document.fill_by_label']);
 for(const s of preparationSkills)for(const m of s.instructions.matchAll(/\b([a-z]+\.[a-z_]+)\b/g))if(m[1]!=='e.g'&&!/\.(pdf|jpg|png|com|gov|sg)$/.test(m[1]!)&&!['fitPhoto.achievedHeadHeightPercent','editingCapabilities.fieldEditing'].some(x=>x.startsWith(m[1]!)))assert.ok(known.has(m[1]!),`${s.name} references unknown ${m[1]}`);
});
