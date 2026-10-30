import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {connectionsHtml,connectionsScript} from '../../core/account/google-page.js';

test('normal request UI module parses and optional save intent is unchecked in the public shell',()=>{
 // Syntax/wire contract only, not browser visual or live journey acceptance.
 const parsed=spawnSync(process.execPath,['--input-type=module','--check'],{input:connectionsScript,encoding:'utf8',timeout:10000});
 assert.equal(parsed.status,0,parsed.stderr);
 assert.match(connectionsHtml,/<textarea id="preparation-request"/);assert.match(connectionsHtml,/<button id="run-preparation">Prepare my files<\/button>/);
 const checkbox=connectionsHtml.match(/<input[^>]+id="preparation-save"[^>]*>/)?.[0];assert.ok(checkbox);assert.doesNotMatch(checkbox,/\bchecked\b/);assert.ok(connectionsHtml.indexOf('id="preparation"')<connectionsHtml.indexOf('id="connections"'));
});
