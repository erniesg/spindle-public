import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore } from '../../core/evidence/store.js';
import { WebReader } from '../../core/tools/web.js';
test('real HTTP read snapshots changing bytes and refuses expanded redirects', async () => {
 let text = 'Photo must be JPEG';
 const server = createServer((req,res) => { if(req.url === '/redirect') {res.writeHead(302,{location:'https://example.org/'});res.end();} else res.end(text); });
 await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
 const address = server.address() as {port:number}; const url = `http://127.0.0.1:${address.port}/`;
 const root=mkdtempSync(join(tmpdir(),'web-')); const store=new EvidenceStore(root);
 try {
 const reader=new WebReader(store,{portal:url,redirect:url+'redirect'},[new URL(url).origin]);
 const a=await reader.read('portal',{workspaceId:'w',accountId:'a'});
 text='Photo optional'; const b=await reader.read('portal',{workspaceId:'w',accountId:'a'});
 assert.notEqual(a.source!.sha256,b.source!.sha256);
 assert.equal(store.read({workspaceId:'w',accountId:'a'},a.artifact.id).toString(),'Photo must be JPEG');
 await assert.rejects(reader.read('redirect',{workspaceId:'w',accountId:'a'}),/destination/);
 await assert.rejects(reader.read('unknown',{workspaceId:'w',accountId:'a'}),/reference/);
 const c=new AbortController();c.abort();await assert.rejects(reader.read('portal',{workspaceId:'w',accountId:'a'},c.signal));
 } finally {store.close();server.close();rmSync(root,{recursive:true,force:true});}
});
