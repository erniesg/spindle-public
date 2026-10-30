// Single public origin for https://spindle.berlayar.ai.
//  - /downloads/*  : only manifest-allowlisted, readback-verified objects from the dedicated
//                    `spindle-downloads` R2 bucket. No listing, no other keys.
//  - everything else: forwarded unchanged to the one loopback Spindle account host through a
//                    Workers VPC service (fixed tunnel + 127.0.0.1:port). The VPC service, not
//                    the request, selects the destination; no other VM port is reachable.
// No CORS headers are added. Host/Origin/Cookie/X-CSRF-Token/Sec-Fetch-* reach the app as sent
// by the browser, so the app's own exact Host/Origin/CSRF/Secure-cookie checks stay authoritative.
import manifest from './downloads.manifest.json' with {type: 'json'};

const PUBLIC_ORIGIN = 'https://spindle.berlayar.ai';
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

const text = (status, body, extra = {}) => new Response(body + '\n', {
  status,
  headers: {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra},
});

/** Exact path -> artifact. Built once; anything absent is 404 without touching R2. */
export function allowlist(m = manifest) {
  if (m?.schemaVersion !== 1 || !Array.isArray(m.artifacts)) throw Error('DOWNLOAD_MANIFEST_INVALID');
  const map = new Map();
  for (const a of m.artifacts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.name) || !/^releases\/[A-Za-z0-9._/-]+$/.test(a.r2Key) || a.r2Key.includes('..')
      || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.sizeBytes) || a.sizeBytes <= 0
      || typeof a.r2Etag !== 'string' || !a.r2Etag || typeof a.contentType !== 'string' || map.has(a.name)) throw Error('DOWNLOAD_MANIFEST_INVALID');
    map.set(a.name, a);
  }
  return map;
}

/** Public, data-free description of what may be downloaded. */
export function publicManifest(m = manifest) {
  return {schemaVersion: 1, sourceRevision: m.sourceRevision ?? null, artifacts: m.artifacts.map(a => ({
    name: a.name, url: `/downloads/${a.name}`, platform: a.platform ?? null, kind: a.kind ?? null, version: a.version ?? null,
    sha256: a.sha256, sizeBytes: a.sizeBytes, signing: a.signing ?? null, label: a.label ?? null,
  }))};
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function downloadsPage(m) {
  const items = publicManifest(m).artifacts.map(a => `<li><a href="${escapeHtml(a.url)}" download>${escapeHtml(a.label ?? a.name)}</a> <small>${escapeHtml([a.platform, a.version, a.signing].filter(Boolean).join(' · '))} · ${a.sizeBytes} bytes · SHA-256 <code>${a.sha256}</code></small></li>`).join('');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spindle downloads</title>'
    + '<h1>Spindle downloads</h1>' + (items ? `<ul>${items}</ul>` : '<p>No downloads are published yet.</p>')
    + '<p><a href="/portal">Open Spindle</a></p></html>';
}

async function serveDownload(request, env, path, m, list) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed', {allow: 'GET, HEAD'});
  if (path === '/downloads' || path === '/downloads/') {
    return new Response(downloadsPage(m), {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"}});
  }
  if (path === '/downloads/manifest.json') {
    return new Response(JSON.stringify(publicManifest(m)), {headers: {'content-type': 'application/json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff'}});
  }
  const name = path.slice('/downloads/'.length);
  const a = list.get(name);
  if (!a) return text(404, 'Not found');
  const object = request.method === 'HEAD' ? await env.DOWNLOADS.head(a.r2Key) : await env.DOWNLOADS.get(a.r2Key);
  // The object must still be the exact bytes verified at staging (size + R2 etag recorded after sha256 readback).
  if (!object || object.size !== a.sizeBytes || object.etag !== a.r2Etag) {
    object?.body?.cancel?.();
    return text(503, 'Download temporarily unavailable');
  }
  const headers = new Headers({
    'content-type': a.contentType,
    'content-length': String(a.sizeBytes),
    'content-disposition': `attachment; filename="${a.name}"`,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'x-spindle-sha256': a.sha256,
    etag: `"${a.r2Etag}"`,
  });
  return new Response(request.method === 'HEAD' ? null : object.body, {headers});
}

function clientNetwork(ip) {
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/.test(ip)) return null;
  if (!ip.includes(':')) {
    const octets = ip.split('.');
    return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? ip : null;
  }
  try {
    // URL's IPv6 parser handles compression and embedded IPv4; never split the raw address.
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [leftText, rightText] = canonical.split('::');
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    const groups = (rightText === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]).map(part => parseInt(part, 16));
    if (groups.length !== 8) return null;
    if (groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff) {
      return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    }
    return 'ipv6:' + groups.slice(0, 4).map(part => part.toString(16).padStart(4, '0')).join(':') + '/64';
  } catch { return null; }
}

async function proxyIdentity(request, env) {
  const token = env.SPINDLE_PROXY_TOKEN;
  const keyHex = env.SPINDLE_CLIENT_ID_KEY;
  const network = clientNetwork(request.headers.get('cf-connecting-ip')?.trim().toLowerCase());
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !/^[a-f0-9]{64}$/.test(keyHex ?? '') || !network) return null;
  const bytes = Uint8Array.from(keyHex.match(/../g), part => parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', bytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('spindle-client-v1\0' + network));
  return {token, client: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')};
}

async function forwardToApp(request, env, url) {
  let identity;
  try { identity = await proxyIdentity(request, env); } catch { return text(503, 'Spindle proxy unavailable'); }
  if (!identity) return text(503, 'Spindle proxy unavailable');
  const headers = new Headers(request.headers);
  for (const h of [...HOP_BY_HOP, 'x-spindle-client', 'x-spindle-proxy-token', 'cf-connecting-ip', 'cf-connecting-ipv6', 'x-forwarded-for', 'x-real-ip', 'true-client-ip', 'forwarded']) headers.delete(h);
  headers.set('x-spindle-client', identity.client);
  headers.set('x-spindle-proxy-token', identity.token);
  headers.delete('host'); // Set from the fetch URL below: exactly the public host the app requires.
  const init = {method: request.method, headers, redirect: 'manual'};
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  let response;
  try {
    // The VPC service ignores this URL's host/port for routing; the host becomes the Host header.
    response = await env.ORIGIN.fetch(`http://${PUBLIC_HOST}${url.pathname}${url.search}`, init);
  } catch {
    return text(502, 'Spindle is temporarily unavailable');
  }
  return response;
}

/** Handler bound to one manifest; the deployed default uses the bundled, reviewed manifest. */
export function createHandler(m = manifest) {
  const list = allowlist(m); // Invalid manifest fails the upload/first request, never serves partially.
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.host === PUBLIC_HOST && url.protocol === 'http:' && (request.method === 'GET' || request.method === 'HEAD')) {
        url.protocol = 'https:';
        return new Response(null, {status: 308, headers: {location: url.href, 'cache-control': 'no-store'}});
      }
      if (url.origin !== PUBLIC_ORIGIN) return text(421, 'Misdirected request');
      if (url.pathname === '/downloads' || url.pathname.startsWith('/downloads/')) return serveDownload(request, env, url.pathname, m, list);
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(null, {status: 302, headers: {location: '/portal', 'cache-control': 'no-store'}});
      }
      return forwardToApp(request, env, url);
    },
  };
}

export default createHandler();
