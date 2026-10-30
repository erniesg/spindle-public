// Exploratory fixed-message Native Messaging host. No activity/file/command API.
const schema = 'spindle-browser-probe/v1';
let pending = Buffer.alloc(0), failed = false, draining = false, ended = false;
function send(id: number, code: string) {
  const body = Buffer.from(JSON.stringify({ schema, id, ok: code === 'CONNECTED', code, capture: false }));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return process.stdout.write(Buffer.concat([header, body]));
}
function fail(code: string) {
  if (failed) return;
  failed = true;
  send(0, code);
  process.exitCode = 1;
  process.stdin.destroy();
  process.stdout.end();
}
function consume() {
  while (!failed && !draining && pending.length >= 4) {
    const size = pending.readUInt32LE();
    if (size > 4096) { fail('FRAME_TOO_LARGE'); return; }
    if (pending.length < size + 4) break;
    const body = pending.subarray(4, size + 4);
    pending = pending.subarray(size + 4);
    let message: unknown;
    try { message = JSON.parse(body.toString('utf8')); }
    catch { fail('INVALID_JSON'); return; }
    const candidate = message !== null && typeof message === 'object' && 'id' in message ? message.id : undefined;
    const id = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1000000 ? candidate : 0;
    const code = !message || Array.isArray(message) || typeof message !== 'object' || Object.keys(message).sort().join(',') !== 'id,kind,schema' || !('kind' in message) || message.kind !== 'hello' || !('id' in message) || message.id !== id
      ? 'INVALID_REQUEST' : !('schema' in message) || message.schema !== schema ? 'UNSUPPORTED_SCHEMA' : 'CONNECTED';
    if (!send(id, code)) {
      draining = true;
      process.stdin.pause();
      process.stdout.once('drain', () => {
        draining = false; consume();
        if (!draining && !failed && !ended) process.stdin.resume();
      });
    }
  }
  if (ended && !draining && !failed && pending.length) fail('TRUNCATED_FRAME');
}
process.stdout.on('error', () => { failed = true; process.stdin.destroy(); process.exitCode = 1; });
process.stdin.on('error', () => { failed = true; process.exitCode = 1; });
if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(process.argv[2] || '')) fail('CALLER_DENIED');
else {
  process.stdin.on('data', chunk => { pending = Buffer.concat([pending, chunk]); consume(); });
  process.stdin.on('end', () => { ended = true; consume(); });
}
