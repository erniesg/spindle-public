import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectUpload } from './validation.js';

export interface PortalConfig {
  title: string;
  fields: { name: string; label: string; required: boolean; minLength?: number; maxLength?: number; pattern?: string; type?: 'text' | 'email' }[];
  attachments: { name: string; label: string; required: boolean; type: string; maxBytes: number; photo?: boolean }[];
  photo?: { width: number; height: number; background: string; maxBytes: number };
}
export const defaultConfig: PortalConfig = {
  title: 'Fictional Learning Workshop — invented data only',
  fields: [{ name: 'name', label: 'Applicant name', required: true }],
  attachments: [{ name: 'statement', label: 'Fictional statement', required: true, type: 'application/pdf', maxBytes: 1000000 }]
};
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Independent fictional destination. Never starts capture or calls external services. */
export async function startPortal(directory: string, config: PortalConfig = defaultConfig, options: { port?: number; loseResponseOnce?: boolean; maxBodyBytes?: number } = {}) {
  await mkdir(directory, { recursive: true });
  let origin = '';
  let lost = false;
  // Serialise commits, including competing requests using the same idempotency identity.
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    const run = async () => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      const send = (status: number, body: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, 'Wrong host or origin');
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        const fields = config.fields.map(f => `<p><label>${escape(f.label)} (${f.required ? 'required' : 'optional'}) <input name="${escape(f.name)}" type="${f.type ?? 'text'}" ${f.minLength === undefined ? '' : `minlength="${f.minLength}"`} ${f.maxLength === undefined ? '' : `maxlength="${f.maxLength}"`} ${f.pattern === undefined ? '' : `pattern="${escape(f.pattern)}"`} ${f.required ? 'required' : ''}></label></p>`).join('');
        const files = config.attachments.map(f => `<p><label>${escape(f.label)} (${f.required ? 'required' : 'optional'}; ${escape(f.type)}; maximum ${f.maxBytes} bytes) <input type="file" name="${escape(f.name)}" accept="${escape(f.type)}" ${f.required ? 'required' : ''}></label></p>`).join('');
        return send(200, `<!doctype html><html><title>${escape(config.title)}</title><h1>${escape(config.title)}</h1><p>Fictional application. Use invented, publishable data only.</p>${config.photo ? `<p>Photo requirements: ${escape(JSON.stringify(config.photo))}. Photo validation supports 8-bit RGB PNG dimensions and bytes only. JPEG RGB photo validation is unsupported; the base JPEG requirement remains pending. Background and visual quality are NOT verified.</p>` : ''}<form method="post" action="/applications" enctype="multipart/form-data">${fields}${files}<label>Submission identity <input name="idempotencyKey" required value="${randomUUID()}"></label><button>Submit</button></form></html>`);
      }
      if (req.method === 'GET' && /^\/receipts\/[a-f0-9]{64}$/.test(url.pathname)) {
        try { return send(200, `<h1>Persisted application receipt</h1><pre>${escape(JSON.stringify(JSON.parse(await readFile(join(directory, url.pathname.slice(10) + '.json'), 'utf8')), null, 2))}</pre>`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return send(404, 'Receipt not found'); throw error; }
      }
      if (req.method !== 'POST' || url.pathname !== '/applications') return send(404, 'Not found');
      if (!req.headers['content-type']?.startsWith('multipart/form-data;')) return send(415, 'Multipart form required');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > (options.maxBodyBytes ?? 3000000)) return send(413, 'Application too large'); chunks.push(Buffer.from(chunk)); }
      let form: FormData;
      try { form = await new Request(origin, { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData(); }
      catch { return send(400, 'Invalid multipart form'); }
      const key = form.get('idempotencyKey');
      if (typeof key !== 'string' || !key || key.length > 200) return send(422, 'Submission identity required (maximum 200 characters)');
      const fields: Record<string, string> = {};
      const files: { name: string; filename: string; type: string; bytes: number; sha256: string }[] = [];
      const contents: Uint8Array[] = [];
      for (const f of config.fields) {
        const value = form.get(f.name);
        if ((f.required && (typeof value !== 'string' || !value.trim())) || (value !== null && typeof value !== 'string')) return send(422, `Invalid field: ${escape(f.label)}`);
        const text = typeof value === 'string' ? value : '';
        if (text && ((f.minLength !== undefined && text.length < f.minLength) || (f.maxLength !== undefined && text.length > f.maxLength) || (f.pattern && !new RegExp(`^(?:${f.pattern})$`, 'u').test(text)) || (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)))) return send(422, `Invalid field: ${escape(f.label)}`);
        fields[f.name] = text;
      }
      for (const f of config.attachments) {
        const file = form.get(f.name);
        if (!(file instanceof File) || !file.size) { if (f.required) return send(422, `Required attachment: ${escape(f.label)}`); continue; }
        if (file.type !== f.type || file.size > f.maxBytes) return send(422, `Invalid attachment: ${escape(f.label)}`);
        const data = new Uint8Array(await file.arrayBuffer());
        try {
          const metadata = inspectUpload(data, file.type);
          if (f.photo && file.type !== 'image/png') return send(422, `Unsupported photo validation: ${escape(f.label)}. RGB PNG only; JPEG RGB validation pending.`);
          if (f.photo && config.photo && (metadata.width !== config.photo.width || metadata.height !== config.photo.height || metadata.color !== 'RGB' || file.size > config.photo.maxBytes)) return send(422, `Invalid photo: ${escape(f.label)}`);
        } catch { return send(422, `Malformed attachment: ${escape(f.label)}`); }
        contents.push(data);
        files.push({ name: f.name, filename: file.name, type: file.type, bytes: file.size, sha256: hash(data) });
      }
      const id = hash(key); const path = join(directory, id + '.json');
      const digest = hash(JSON.stringify({ fields, files }));
      try {
        const prior = JSON.parse(await readFile(path, 'utf8'));
        if (prior.digest !== digest) return send(409, 'Submission identity already used for different content');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        for (let i = 0; i < files.length; i++) await writeFile(join(directory, files[i]!.sha256 + '.upload'), contents[i]!);
        const receipt = { reference: id, status: 'submitted', submittedAt: new Date().toISOString(), idempotencyKey: key, digest, fields, files };
        const temp = path + '.tmp'; await writeFile(temp, JSON.stringify(receipt)); await rename(temp, path);
      }
      if (options.loseResponseOnce && !lost) { lost = true; req.socket.destroy(); return; }
      res.writeHead(303, { Location: `/receipts/${id}` }); res.end();
    };
    queue = queue.then(run).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Storage or request failure'); });
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // A closed client socket does not settle its accepted asynchronous commit.
    await queue;
  } };
}
