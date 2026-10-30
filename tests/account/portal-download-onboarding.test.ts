import {test} from 'node:test';
import assert from 'node:assert/strict';
import {portalAsset} from '../../core/account/portal/assets.js';

test('served tracking onboarding uses the public catalogue and ordinary app/Chrome setup, not private PR or shell launchers',async()=>{
 const asset=await portalAsset('/portal/code/account/portal/tracking.js');
 assert.equal(asset?.type,'text/javascript; charset=utf-8');const body=String(asset?.body);
 assert.match(body,/href: ['"]\/downloads['"]/);
 assert.match(body,/Spindle\.app/);assert.match(body,/Register this Chrome extension/);
 assert.match(body,/not notarized/);assert.match(body,/do not substitute an old or unrelated download/);
 assert.doesNotMatch(body,/Start Spindle Preview\.command|Enroll Browser\.command|private Mac ZIP|shasum -a 256/);
});
