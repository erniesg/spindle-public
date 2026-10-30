// Focused checks for the public-origin Worker. Run: node --test deploy/spindle-web/tests/
// Uses in-memory fakes for the R2 and VPC bindings; proves routing/allowlist/header logic only,
// not Cloudflare edge, Workers VPC connectivity or the live app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler, allowlist} from '../src/worker.js';

const PROXY_TOKEN = '1'.repeat(64);
const CLIENT_KEY = '2'.repeat(64);
const CLIENT_IP = '198.51.100.1';
const clientTag = ip => createHmac('sha256', Buffer.from(CLIENT_KEY, 'hex')).update('spindle-client-v1\0' + ip.toLowerCase()).digest('hex');

const artifact = {name: 'Spindle-0.3.0-mac.zip', r2Key: 'releases/abc/Spindle-0.3.0-mac.zip', sha256: 'a'.repeat(64), sizeBytes: 5, r2Etag: 'etag1', contentType: 'application/zip', platform: 'macos', version: '0.3.0'};
const manifest = {schemaVersion: 1, sourceRevision: 'f'.repeat(40), artifacts: [artifact]};

function env({object = {size: 5, etag: 'etag1', body: new Blob(['hello']).stream()}} = {}) {
  const calls = {r2: [], origin: []};
  return {
    calls,
    SPINDLE_PROXY_TOKEN: PROXY_TOKEN,
    SPINDLE_CLIENT_ID_KEY: CLIENT_KEY,
    DOWNLOADS: {
      async get(key) { calls.r2.push(['get', key]); return key === artifact.r2Key ? object : null; },
      async head(key) { calls.r2.push(['head', key]); return key === artifact.r2Key ? object : null; },
    },
    ORIGIN: {
      async fetch(input, init) {
        calls.origin.push({url: input, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect, body: init.body ? await new Response(init.body).text() : undefined});
        return new Response('app', {status: 200, headers: {'set-cookie': 'spindle_session=x; HttpOnly; SameSite=Strict; Path=/; Secure'}});
      },
    },
  };
}
const worker = createHandler(manifest);

test('entry module does not export primitive workerd entrypoints', async () => {
  for (const [name, value] of Object.entries(await import('../src/worker.js'))) {
    assert.ok(typeof value === 'function' || (typeof value === 'object' && value !== null), `unsupported primitive export: ${name}`);
  }
});

test('only the exact HTTP host upgrades read-only requests to HTTPS', async () => {
  for (const method of ['GET', 'HEAD']) {
    const e = env();
    const res = await worker.fetch(new Request('http://spindle.berlayar.ai/connections?x=1', {method}), e);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://spindle.berlayar.ai/connections?x=1');
    assert.equal(e.calls.r2.length + e.calls.origin.length, 0);
  }
  assert.equal((await worker.fetch(new Request('http://evil.example/'), env())).status, 421);
  assert.equal((await worker.fetch(new Request('http://spindle.berlayar.ai/session', {method: 'POST', body: '{}'}), env())).status, 421);
});

test('allowlisted download streams verified object with attachment headers and no CORS', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://spindle.berlayar.ai/downloads/Spindle-0.3.0-mac.zip'), e);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Spindle-0.3.0-mac.zip"');
  assert.equal(res.headers.get('x-spindle-sha256'), artifact.sha256);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(e.calls.r2, [['get', artifact.r2Key]]);
  assert.equal(e.calls.origin.length, 0);
});

test('unlisted names, traversal and bucket keys never reach R2 or the app', async () => {
  for (const path of ['/downloads/other.zip', '/downloads/releases/abc/Spindle-0.3.0-mac.zip', '/downloads/..%2Fsecret', '/downloads/installers/windows/x.zip']) {
    const e = env();
    const res = await worker.fetch(new Request('https://spindle.berlayar.ai' + path), e);
    assert.equal(res.status, 404, path);
    assert.equal(e.calls.r2.length + e.calls.origin.length, 0, path);
  }
});

test('changed or missing object bytes fail closed instead of serving', async () => {
  for (const object of [{size: 5, etag: 'other', body: new Blob(['hello']).stream()}, {size: 6, etag: 'etag1', body: new Blob(['hello!']).stream()}, null]) {
    const res = await worker.fetch(new Request('https://spindle.berlayar.ai/downloads/Spindle-0.3.0-mac.zip'), env({object}));
    assert.equal(res.status, 503);
  }
});

test('downloads are read-only', async () => {
  const res = await worker.fetch(new Request('https://spindle.berlayar.ai/downloads/Spindle-0.3.0-mac.zip', {method: 'PUT', body: 'x'}), env());
  assert.equal(res.status, 405);
});

test('public manifest exposes only public fields', async () => {
  const res = await worker.fetch(new Request('https://spindle.berlayar.ai/downloads/manifest.json'), env());
  const body = await res.json();
  assert.equal(body.artifacts[0].url, '/downloads/Spindle-0.3.0-mac.zip');
  assert.equal(JSON.stringify(body).includes('releases/abc'), false);
  assert.equal(JSON.stringify(body).includes('etag1'), false);
});

test('app requests keep exact Host, Origin, cookie and CSRF; body, method and Set-Cookie pass through', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://spindle.berlayar.ai/session?x=1', {
    method: 'POST', body: '{"a":1}',
    headers: {origin: 'https://spindle.berlayar.ai', cookie: 'spindle_session=abc', 'x-csrf-token': 't', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'cf-connecting-ip': CLIENT_IP, 'x-spindle-client': 'spoofed', 'x-spindle-proxy-token': 'spoofed', 'x-forwarded-for': '203.0.113.9'},
  }), e);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Secure/);
  const [call] = e.calls.origin;
  assert.equal(new URL(call.url).host, 'spindle.berlayar.ai');
  assert.equal(new URL(call.url).pathname + new URL(call.url).search, '/session?x=1');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'manual');
  assert.equal(call.body, '{"a":1}');
  assert.equal(call.headers.origin, 'https://spindle.berlayar.ai');
  assert.equal(call.headers.cookie, 'spindle_session=abc');
  assert.equal(call.headers['x-csrf-token'], 't');
  assert.equal(call.headers['sec-fetch-site'], 'same-origin');
  assert.equal(call.headers.host, undefined); // Host is derived from the fetch URL, never copied.
  assert.equal(call.headers['x-spindle-client'], clientTag(CLIENT_IP));
  assert.equal(call.headers['x-spindle-proxy-token'], PROXY_TOKEN);
  assert.equal(call.headers['cf-connecting-ip'], undefined);
  assert.equal(call.headers['x-forwarded-for'], undefined);
});

test('cross-origin Origin header is forwarded unchanged so the app rejects it', async () => {
  const e = env();
  await worker.fetch(new Request('https://spindle.berlayar.ai/session', {method: 'POST', body: '{}', headers: {origin: 'https://evil.example', 'cf-connecting-ip': CLIENT_IP}}), e);
  assert.equal(e.calls.origin[0].headers.origin, 'https://evil.example');
});

test('other hostnames are refused; root goes to the account-capable portal', async () => {
  assert.equal((await worker.fetch(new Request('https://spindle-downloads.example.workers.dev/session'), env())).status, 421);
  const root = await worker.fetch(new Request('https://spindle.berlayar.ai/'), env());
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/portal');
});

test('origin outage is an honest 502, not a substitute page', async () => {
  const e = env();
  e.ORIGIN.fetch = async () => { throw Error('down'); };
  assert.equal((await worker.fetch(new Request('https://spindle.berlayar.ai/connections', {headers: {'cf-connecting-ip': CLIENT_IP}}), e)).status, 502);
});

test('proxy pseudonym follows only Cloudflare client IP, including IPv6, not spoofed tags', async () => {
  const tags = [];
  for (const ip of [CLIENT_IP, CLIENT_IP, '2001:DB8::1']) {
    const e = env();
    const res = await worker.fetch(new Request('https://spindle.berlayar.ai/portal', {headers: {
      'cf-connecting-ip': ip, 'x-spindle-client': 'spoof-' + tags.length, 'x-spindle-proxy-token': 'attacker',
      'forwarded': 'for=203.0.113.9', 'x-real-ip': '203.0.113.9', 'true-client-ip': '203.0.113.9',
    }}), e);
    assert.equal(res.status, 200);
    const headers = e.calls.origin[0].headers;
    assert.equal(headers['x-spindle-client'], clientTag(ip.includes(':') ? 'ipv6:2001:0db8:0000:0000/64' : ip));
    assert.match(headers['x-spindle-client'], /^[a-f0-9]{64}$/);
    for (const name of ['forwarded', 'x-real-ip', 'true-client-ip']) assert.equal(headers[name], undefined);
    tags.push(headers['x-spindle-client']);
  }
  assert.equal(tags[0], tags[1]);
  assert.notEqual(tags[0], tags[2]);
});

test('IPv6 /64 identity is canonical across compression and host rotation; IPv4 stays distinct', async () => {
  const expected = clientTag('ipv6:2001:0db8:0000:0000/64');
  for (const ip of ['2001:db8::1', '2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::cafe', '2001:db8:0:0:1234:5678:9abc:def0']) {
    const e = env();
    assert.equal((await worker.fetch(new Request('https://spindle.berlayar.ai/portal', {headers: {'cf-connecting-ip': ip}}), e)).status, 200);
    assert.equal(e.calls.origin[0].headers['x-spindle-client'], expected);
  }
  const other = env();
  await worker.fetch(new Request('https://spindle.berlayar.ai/portal', {headers: {'cf-connecting-ip': '2001:db8:0:1::1'}}), other);
  assert.equal(other.calls.origin[0].headers['x-spindle-client'], clientTag('ipv6:2001:0db8:0000:0001/64'));
  assert.notEqual(other.calls.origin[0].headers['x-spindle-client'], expected);
  const mapped = env();
  await worker.fetch(new Request('https://spindle.berlayar.ai/portal', {headers: {'cf-connecting-ip': '::ffff:198.51.100.1'}}), mapped);
  assert.equal(mapped.calls.origin[0].headers['x-spindle-client'], clientTag(CLIENT_IP));
});

test('missing or malformed proxy configuration/client identity fails before app forwarding', async () => {
  for (const [field, value] of [['SPINDLE_PROXY_TOKEN', undefined], ['SPINDLE_CLIENT_ID_KEY', 'invalid'], ['SPINDLE_PROXY_TOKEN', ''], ['ip', undefined], ['ip', 'not-an-ip'], ['ip', '1::2::3'], ['ip', '999.1.1.1']]) {
    const e = env();
    if (field !== 'ip') e[field] = value;
    const headers = field === 'ip' && value === undefined ? {} : {'cf-connecting-ip': field === 'ip' ? value : CLIENT_IP};
    const res = await worker.fetch(new Request('https://spindle.berlayar.ai/session', {headers}), e);
    assert.equal(res.status, 503);
    assert.equal(e.calls.origin.length, 0);
    assert.equal((await res.text()).includes(PROXY_TOKEN), false);
  }
});

test('public downloads do not require proxy secrets or a client identity', async () => {
  const e = env();
  delete e.SPINDLE_PROXY_TOKEN;
  delete e.SPINDLE_CLIENT_ID_KEY;
  const res = await worker.fetch(new Request('https://spindle.berlayar.ai/downloads/manifest.json'), e);
  assert.equal(res.status, 200);
  assert.equal(e.calls.origin.length, 0);
});

test('malformed manifests are rejected', () => {
  for (const bad of [{...artifact, r2Key: 'reviews/spindle/x'}, {...artifact, r2Key: 'releases/../x'}, {...artifact, name: '../x'}, {...artifact, sha256: 'z'}, {...artifact, r2Etag: ''}]) {
    assert.throws(() => allowlist({schemaVersion: 1, artifacts: [bad]}), /DOWNLOAD_MANIFEST_INVALID/);
  }
  assert.throws(() => allowlist({schemaVersion: 1, artifacts: [artifact, artifact]}), /DOWNLOAD_MANIFEST_INVALID/);
});
