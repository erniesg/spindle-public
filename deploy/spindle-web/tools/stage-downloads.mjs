#!/usr/bin/env node
// Stage approved public product artifacts for https://spindle.berlayar.ai/downloads/.
//
//   node stage-downloads.mjs plan   <spec.json>   # local hashing only; prints exact commands, no effects
//   node stage-downloads.mjs upload <spec.json>   # EFFECT E6: reviewed public artifact put into spindle-downloads/releases/<rev>/<sha256>/
//   node stage-downloads.mjs verify <spec.json>   # readback sha256 + live etag -> writes src/downloads.manifest.json
//
// spec.json (kept outside Git if it names private local paths):
//   {"sourceRevision":"<40-hex release head from the product integrator>",
//    "artifacts":[{"name":"Spindle-0.3.0-mac.zip","file":"/abs/path","sha256":"<expected, from the reviewed release record>",
//                  "contentType":"application/zip","platform":"macos","kind":"desktop","version":"0.3.0",
//                  "signing":"unsigned","label":"Spindle for Mac (test build)"}]}
// The expected sha256 must come from the independently reviewed release record; a mismatch aborts.
// Set CLOUDFLARE_ACCOUNT_ID to your own account ID before running any mode.
// Credentials: wrangler's own login for put/get; verify reads wrangler's OAuth token in memory only
// to GET object metadata. Nothing secret is printed or passed in argv.
import {createHash} from 'node:crypto';
import {createReadStream, readFileSync, writeFileSync, statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {allowlist} from '../src/worker.js';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/i.test(ACCOUNT ?? '') || /^0{32}$/.test(ACCOUNT)) {
  throw Error('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
}
const BUCKET = 'spindle-downloads';
const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'downloads.manifest.json');
const PUBLIC_FIELDS = ['platform', 'kind', 'version', 'signing', 'label'];

const [mode, specPath] = process.argv.slice(2);
if (!['plan', 'upload', 'verify'].includes(mode) || !specPath) { console.error('usage: stage-downloads.mjs plan|upload|verify <spec.json>'); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (!/^[a-f0-9]{40}$/.test(spec.sourceRevision ?? '')) throw Error('SOURCE_REVISION_REQUIRED');
const key = a => `releases/${spec.sourceRevision}/${a.sha256}/${a.name}`;

const sha256Stream = stream => new Promise((resolve, reject) => {
  const h = createHash('sha256'); let size = 0;
  stream.on('data', c => { h.update(c); size += c.length; }).on('error', reject).on('end', () => resolve({sha256: h.digest('hex'), size}));
});
const run = (args, capture = false) => new Promise((resolve, reject) => {
  const child = spawn('wrangler', args, {stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: {...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_SEND_METRICS: 'false', CI: '1'}});
  const done = capture ? sha256Stream(child.stdout) : Promise.resolve(undefined);
  child.on('error', reject).on('exit', async code => code === 0 ? resolve(await done) : reject(Error(`wrangler exited ${code}`)));
});
async function liveObject(k) {
  const toml = readFileSync(join(homedir(), '.wrangler', 'config', 'default.toml'), 'utf8');
  const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!token) throw Error('WRANGLER_LOGIN_REQUIRED');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects?prefix=${encodeURIComponent(k)}&per_page=10`, {headers: {authorization: `Bearer ${token}`}});
  const body = await r.json();
  if (!body.success) throw Error('R2_METADATA_READ_FAILED ' + JSON.stringify(body.errors?.map(e => e.code)));
  return body.result.find(o => o.key === k);
}

const checked = [];
for (const a of spec.artifacts ?? []) {
  if (!isAbsolute(a.file ?? '')) throw Error('ABSOLUTE_FILE_REQUIRED ' + a.name);
  const local = await sha256Stream(createReadStream(a.file));
  if (local.sha256 !== a.sha256 || local.size !== statSync(a.file).size) throw Error(`LOCAL_HASH_MISMATCH ${a.name}`);
  checked.push({...a, sizeBytes: local.size});
}
// Validate names/keys with the Worker's own rules before any effect.
allowlist({schemaVersion: 1, artifacts: checked.map(a => ({...a, r2Key: key(a), r2Etag: 'pending'}))});

if (mode === 'plan') {
  for (const a of checked) console.log(`wrangler r2 object put ${BUCKET}/${key(a)} --file ${JSON.stringify(a.file)} --content-type ${a.contentType} --remote   # ${a.sizeBytes} bytes sha256 ${a.sha256}`);
} else if (mode === 'upload') {
  // Refresh existing OAuth through Wrangler; identity output is hashed/discarded, not logged.
  await run(['whoami'], true);
  for (const a of checked) {
    const existing = await liveObject(key(a));
    if (existing) {
      const back = await run(['r2', 'object', 'get', `${BUCKET}/${key(a)}`, '--pipe', '--remote'], true);
      if (existing.size !== a.sizeBytes || back.size !== a.sizeBytes || back.sha256 !== a.sha256) throw Error(`EXISTING_OBJECT_CONFLICT ${a.name}`);
      console.log(`already verified ${a.name}; no upload`);
      continue;
    }
    await run(['r2', 'object', 'put', `${BUCKET}/${key(a)}`, '--file', a.file, '--content-type', a.contentType, '--remote']);
  }
} else {
  const artifacts = [];
  for (const a of checked) {
    const back = await run(['r2', 'object', 'get', `${BUCKET}/${key(a)}`, '--pipe', '--remote'], true);
    if (back.sha256 !== a.sha256 || back.size !== a.sizeBytes) throw Error(`READBACK_MISMATCH ${a.name}`);
    const live = await liveObject(key(a));
    if (!live || live.size !== a.sizeBytes || !live.etag) throw Error(`LIVE_METADATA_MISMATCH ${a.name}`);
    artifacts.push({name: a.name, r2Key: key(a), sha256: a.sha256, sizeBytes: a.sizeBytes, r2Etag: live.etag, contentType: a.contentType,
      ...Object.fromEntries(PUBLIC_FIELDS.filter(f => a[f] !== undefined).map(f => [f, a[f]]))});
    console.log(`verified ${a.name} sha256 ${a.sha256} etag ${live.etag}`);
  }
  const manifest = {schemaVersion: 1, sourceRevision: spec.sourceRevision, artifacts};
  allowlist(manifest);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${MANIFEST}`);
}
