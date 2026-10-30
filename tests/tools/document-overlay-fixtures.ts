import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createDocumentTools} from '../../core/tools/documents.js';
import type {ToolContext} from '../../core/agent/contracts.js';
export const backend={pdftoppmExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOPPM,pdftotextExecutable:process.env.SPINDLE_DOCUMENT_TEST_PDFTOTEXT};
export async function overlayFixture(bytes:Uint8Array,options:Parameters<typeof createDocumentTools>[1]=backend) {
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local','pdf-overlay-'));const store=new EvidenceStore(dir),ns={workspaceId:'overlay',accountId:'invented'};
 const source=store.put(ns,bytes,'application/pdf',[],{provider:'user',providerId:'invented-overlay'}).source!;
 const controller=new AbortController();const ctx:ToolContext={...ns,callId:'overlay',taskId:'task',runId:'run',scope:{sources:[source],grants:['document.processing'],destinations:[]},signal:controller.signal,budget:{used:0,limit:40},isCurrent:()=>true};
 const tools=createDocumentTools(store,options);
 return {dir,store,ns,source,ctx,controller,tools,async call(op:string,args:Record<string,unknown>={}){const tool=tools.find(t=>t.name===`document.${op}`);assert.ok(tool);return tool.invoke(tool.inputSchema.parse({inputId:source.id,...args}),ctx);},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
export const placement=(value='0098765')=>({type:'text',box:{x:40,y:60,width:170,height:30},value,fontSize:14});
