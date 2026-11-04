// Local protocol fakes only: no Cloudflare calls, credentials or actual uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, delimiter} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const stager = fileURLToPath(new URL('../tools/stage-downloads.mjs', import.meta.url));
const scratch = process.env.RUCKSACK_SCRATCH_ROOT ?? join(homedir(), '.local/state/rucksack/scratch');
const sha = createHash('sha256').update('hello').digest('hex');
const revision = 'f'.repeat(40);

for (const existing of ['absent', 'identical', 'conflict']) {
  test(`upload ${existing}: create once, reuse identical, never overwrite conflicts`, t => {
    mkdirSync(scratch, {recursive: true});
    const dir = mkdtempSync(join(scratch, 'spindle-stager-test-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, '.wrangler/config'), {recursive: true});
    writeFileSync(join(dir, '.wrangler/config/default.toml'), 'oauth_token = "invented-local-test-only"\n');
    const file = join(dir, 'fixture.zip');
    writeFileSync(file, 'hello');
    const spec = join(dir, 'spec.json');
    writeFileSync(spec, JSON.stringify({sourceRevision: revision, artifacts: [{name: 'fixture.zip', file, sha256: sha, contentType: 'application/zip'}]}));
    const log = join(dir, 'actions');
    const preload = join(dir, 'fake-fetch.mjs');
    writeFileSync(preload, `globalThis.fetch = async input => {
      const u = new URL(input);
      if (u.hostname !== 'api.cloudflare.com') throw Error('UNEXPECTED_NETWORK');
      return new Response(JSON.stringify({success:true,result:process.env.FAKE_EXISTING === 'absent' ? [] : [{key:u.searchParams.get('prefix'),size:5,etag:'fixture'}]}));
    };`);
    writeFileSync(join(bin, 'wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'whoami') process.stdout.write('fixture-identity-not-for-logs');
else if (a[2] === 'get') process.stdout.write(process.env.FAKE_EXISTING === 'conflict' ? 'wrong' : 'hello');
else if (a[2] !== 'put') process.exit(2);
`, {mode: 0o700});
    const result = spawnSync(process.execPath, [stager, 'upload', spec], {
      encoding: 'utf8', env: {...process.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), HOME: dir, PATH: bin + delimiter + process.env.PATH,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
        FAKE_EXISTING: existing, FAKE_LOG: log},
    });
    const actions = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const puts = actions.filter(a => a[2] === 'put');
    assert.equal(result.stdout.includes('fixture-identity-not-for-logs'), false);
    assert.deepEqual(actions[0], ['whoami']);
    assert.equal(puts.length, existing === 'absent' ? 1 : 0);
    if (existing === 'conflict') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EXISTING_OBJECT_CONFLICT/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      if (existing === 'absent') assert.equal(puts[0][3], `spindle-downloads/releases/${revision}/${sha}/fixture.zip`);
      else assert.match(result.stdout, /no upload/);
    }
  });
}

for (const account of ['', 'invalid', '0'.repeat(32)]) {
  test(`staging rejects missing, invalid or placeholder account: ${account || 'missing'}`, () => {
    const result = spawnSync(process.execPath, [stager, 'plan', 'nonexistent-spec.json'], {
      encoding: 'utf8', env: {...process.env, CLOUDFLARE_ACCOUNT_ID: account},
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID_REQUIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  });
}
