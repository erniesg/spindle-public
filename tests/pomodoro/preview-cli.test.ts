import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewLaunchOptions} from '../../core/preview/app.js';
test('ordinary native preview CLI can suppress default-browser opening without changing normal defaults',()=>{
 assert.deepEqual(previewLaunchOptions([]),{noOpen:false});
 assert.deepEqual(previewLaunchOptions(['--no-open']),{noOpen:true});
 assert.deepEqual(previewLaunchOptions(['--desktop-shell'],'a'.repeat(64)),{noOpen:true,desktopNonce:'a'.repeat(64)});
 assert.throws(()=>previewLaunchOptions(['--desktop-shell'],''),/DESKTOP_NONCE_REQUIRED/);
 for(const args of [['--unknown'],['--no-open','--unknown'],['--no-open','--no-open']])assert.throws(()=>previewLaunchOptions(args),/PREVIEW_ARGUMENTS_REQUIRED/);
});
