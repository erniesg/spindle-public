import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { record, type NativeLauncher } from './types.js';

export function nativeExecutable(root: string) {
  if (process.platform === 'darwin') return join(root, '.local/capture-check/SpindleCaptureCheck.app/Contents/MacOS/SpindleCaptureCheck');
  if (process.platform === 'win32') return [join(root, 'runtime/SpindleCaptureCheck.exe'), join(root, '.local/native-windows/SpindleCaptureCheck.exe')].find(existsSync);
  return null;
}

export const launchNative: NativeLauncher = (root, fixture, onEvent, onExit) => {
  let args;
  if (process.platform === 'darwin' && ['MAC_BUILD_FAILED', 'MAC_TOOLS_REQUIRED'].includes(process.env.SPINDLE_CHECK_MAC_FAILURE ?? '')) {
    const code = process.env.SPINDLE_CHECK_MAC_FAILURE;
    queueMicrotask(async () => {
      let log = '';
      try { log = (await readFile(join(root, '.local/capture-check/build.log'), 'utf8')).slice(0, 65536); } catch { /* No compiler ran if CLT is missing. */ }
      const diagnostics = [...log.matchAll(/CaptureCheck\.swift:(\d+):(\d+): error:/g)].slice(0, 20).map(match => ({ line: Number(match[1]), column: Number(match[2]), code: 'SWIFT_ERROR' }));
      onEvent({ kind: 'error', code, diagnostics }); onExit();
    });
    return { pid: 0, send() {}, stop() {} };
  }
  const command = nativeExecutable(root);
  if (process.platform === 'darwin') {
    args = fixture ? ['--fixture'] : [];
  } else if (process.platform === 'win32') {
    if (!command) {
      queueMicrotask(() => { onEvent({ kind: 'error', code: 'WINDOWS_HELPER_MISSING' }); onExit(); });
      return { pid: 0, send() {}, stop() {} };
    }
    args = fixture ? ['--fixture'] : [];
  } else {
    queueMicrotask(() => { onEvent({ kind: 'error', code: 'NATIVE_UNAVAILABLE' }); onExit(); });
    return { pid: 0, send() {}, stop() {} };
  }
  if (!command) throw new Error('NATIVE_UNAVAILABLE');
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let ended = false;
  const finish = () => { if (!ended) { ended = true; onExit(); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 65536) { child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.length > 16384) { child.kill(); return; }
      try { const event: unknown = JSON.parse(line); if (record(event)) onEvent(event); } catch { /* Untrusted native output is not a log. */ }
    }
  });
  // Never forward compiler errors or native stderr into diagnostics/HTTP logs.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => { onEvent({ kind: 'error', code: fixture ? 'FIXTURE_FAILED' : 'HELPER_EXITED' }); finish(); });
  child.on('exit', finish);
  return {
    get pid() { return child.pid || 0; },
    send(value) { if (!ended && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); },
    stop() {
      if (ended) return;
      if (!child.stdin.destroyed) child.stdin.end('{"action":"quit"}\n');
      const deadline = setTimeout(() => { if (!ended) child.kill(); }, 1000);
      deadline.unref();
    },
  };
}
