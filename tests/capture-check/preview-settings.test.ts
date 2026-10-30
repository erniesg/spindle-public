import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PreviewSettingsStore,type PreviewSettings} from '../../core/preview/settings.js';
import {PreviewSession} from '../../core/preview/session.js';

test('profile enrollment and native choices survive encrypted disk restart; revoke removes enrollment',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const key=Buffer.alloc(32,21),token='ab'.repeat(32);
 const saved:PreviewSettings={schema:'spindle-preview-settings/v1',profileToken:token,preferences:{apps:['com.apple.TextEdit'],pixels:true,rich:true,retain:true}};
 await new PreviewSettingsStore(dir).write(saved,key);
 const disk=await readFile(join(dir,'context.enc'));assert.ok(!disk.includes(Buffer.from(token)));assert.ok(!disk.includes(Buffer.from('TextEdit')));
 assert.deepEqual(await new PreviewSettingsStore(dir).read(key),saved);
 await assert.rejects(()=>new PreviewSettingsStore(dir).read(Buffer.alloc(32,22)));
 assert.equal(new PreviewSession().recording,false,'settings restoration never starts a session');
 await new PreviewSettingsStore(dir).write({...saved,profileToken:null},key);
 assert.equal((await new PreviewSettingsStore(dir).read(key)).profileToken,null);
});
