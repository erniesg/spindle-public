import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const host = fileURLToPath(new URL('../host.js', import.meta.url));
const origin = `chrome-extension://${'a'.repeat(32)}/`;
const hello = { schema: 'spindle-browser-probe/v1', id: 1, kind: 'hello' };
function frame(message: unknown) {
  const body = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function run(chunks: Uint8Array[], caller = origin, slowOutput = false) {
  const child = spawn(process.execPath, [host, caller], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  if (slowOutput) child.stdout.pause();
  const resume = slowOutput ? setTimeout(() => child.stdout.resume(), 150) : undefined;
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 3000);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
    const result = await exited;
    assert.equal(result.signal, null, 'host must exit on pipe closure, not time out');
    assert.equal(Buffer.concat(errors).length, 0, 'no raw errors/paths on stderr');
    let bytes = Buffer.concat(output);
    const messages: Record<string, unknown>[] = [];
    while (bytes.length) {
      assert.ok(bytes.length >= 4);
      const size = bytes.readUInt32LE();
      assert.ok(size <= 4096 && bytes.length >= size + 4);
      messages.push(JSON.parse(bytes.subarray(4, size + 4).toString('utf8')));
      bytes = bytes.subarray(size + 4);
    }
    return { ...result, messages };
  } finally { clearTimeout(timeout); clearTimeout(resume); if (child.exitCode === null) child.kill(); }
}

test('real process exchanges bounded versioned frames and exits at EOF', async () => {
  const bytes = frame(hello);
  const result = await run([bytes.subarray(0, 2), bytes.subarray(2), frame({ ...hello, id: 2 })]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.messages, [1, 2].map(id => ({ schema: hello.schema, id, ok: true, code: 'CONNECTED', capture: false })));
});

test('unknown versions and arbitrary payloads fail without echoing content; valid retry works', async () => {
  const result = await run([frame({ ...hello, schema: 'spindle-browser-probe/v99' }), frame({ ...hello, secret: 'DO_NOT_ECHO' }), frame(hello)]);
  assert.deepEqual(result.messages.map(message => message.code), ['UNSUPPORTED_SCHEMA', 'INVALID_REQUEST', 'CONNECTED']);
  assert.ok(!JSON.stringify(result.messages).includes('DO_NOT_ECHO'));
});

test('malformed JSON, oversized lengths and truncated frames fail explicitly', async () => {
  assert.equal((await run([frame('{bad JSON')])).messages[0].code, 'INVALID_JSON');
  const large = Buffer.alloc(4); large.writeUInt32LE(4097);
  assert.equal((await run([large])).messages[0].code, 'FRAME_TOO_LARGE');
  assert.equal((await run([Buffer.from([5, 0])])).messages[0].code, 'TRUNCATED_FRAME');
});

test('slow stdout drains complete queued frames before treating EOF as truncation', async () => {
  const result = await run(Array.from({ length: 5000 }, (_, index) => frame({ ...hello, id: index + 1 })), origin, true);
  assert.equal(result.code, 0);
  assert.equal(result.messages.length, 5000);
  assert.ok(result.messages.every((message, index) => message.code === 'CONNECTED' && message.id === index + 1));
});

test('non-extension callers are rejected before processing input', async () => {
  const result = await run([frame(hello)], 'https://untrusted.invalid/');
  assert.equal(result.code, 1);
  assert.equal(result.messages[0].code, 'CALLER_DENIED');
});
