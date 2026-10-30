// Packaged pre-launch check of the precompiled macOS arm64 Preview helper.
// Structural only: proves the packaged bytes match their producer record and the
// packaged Preview.swift, not that the helper was natively executed or accepted.
// Mirrors tools/build_macos_preview.py so a user Mac needs no Python/devstack.
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'spindle-macos-preview-native/v1';
export const SOURCE_INPUT = 'platforms/macos/Preview.swift';
const MIN_MACOS = '15.0';
const KEYS = ['binarySha256', 'bytes', 'codesignVerified', 'compiler', 'fixtureSha256', 'inputs', 'minMacos', 'schema', 'sdk', 'sourceDirty', 'sourceRevision', 'sourceTree', 'target'];
const MAX_BINARY_BYTES = 64 * 1024 * 1024, MAX_MANIFEST_BYTES = 64 * 1024, MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/, SDK = /^\d+(\.\d+){0,2}$/;

export class MacPreviewCacheError extends Error {}
const fail = (code: string): never => { throw new MacPreviewCacheError(code); };
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function readRegular(path: string, limit: number, code: string): Buffer {
  let info;
  try { info = lstatSync(path); } catch { return fail(code + '_MISSING'); }
  if (info.isSymbolicLink() || !info.isFile()) fail(code + '_NOT_REGULAR');
  if (info.size > limit) fail(code + '_OVERSIZE');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const data = Buffer.alloc(limit + 1);
    let length = 0, read = 0;
    while (length < data.length && (read = readSync(descriptor, data, length, data.length - length, null)) > 0) length += read;
    if (length > limit) fail(code + '_OVERSIZE');
    return data.subarray(0, length);
  } finally { closeSync(descriptor); }
}

const machoVersion = (value: number) => `${value >>> 16}.${(value >>> 8) & 0xff}` + ((value & 0xff) ? `.${value & 0xff}` : '');

/** Thin 64-bit arm64 MH_EXECUTE with macOS LC_BUILD_VERSION minos and a signature blob. */
export function validateMacho(data: Buffer): void {
  if (data.length < 32) fail('MACHO_TRUNCATED');
  if (data.readUInt32LE(0) !== 0xfeedfacf) fail('MACHO_NOT_THIN_64');
  if (data.readUInt32LE(4) !== 0x0100000c) fail('MACHO_ARCHITECTURE_MISMATCH');
  if (data.readUInt32LE(12) !== 2) fail('MACHO_NOT_EXECUTABLE');
  const commands = data.readUInt32LE(16), end = 32 + data.readUInt32LE(20);
  if (end > data.length) fail('MACHO_TRUNCATED');
  let offset = 32, build: [number, number] | undefined, signed = false;
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > end) fail('MACHO_LOAD_COMMANDS');
    const command = data.readUInt32LE(offset), size = data.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) fail('MACHO_LOAD_COMMANDS');
    if (command === 0x32) {
      if (size < 24 || build) fail('MACHO_BUILD_VERSION');
      build = [data.readUInt32LE(offset + 8), data.readUInt32LE(offset + 12)];
    } else if (command === 0x1d) signed = true;
    offset += size;
  }
  if (!build || build[0] !== 1) fail('MACHO_PLATFORM_MISMATCH');
  if (machoVersion(build![1]) !== MIN_MACOS) fail('MACHO_MINIMUM_OS_MISMATCH');
  if (!signed) fail('MACHO_UNSIGNED');
}

type Manifest = { sourceRevision: string; inputs: Record<string, string>; binarySha256: string; fixtureSha256: string; bytes: number };
function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== KEYS.join()) fail('MANIFEST_KEYS');
  const m = value as Record<string, unknown>, inputs = m.inputs as Record<string, unknown>;
  const ok = m.schema === SCHEMA && m.target === 'macos-arm64'
    && typeof m.sourceRevision === 'string' && HEX40.test(m.sourceRevision)
    && typeof m.sourceTree === 'string' && HEX40.test(m.sourceTree)
    && m.sourceDirty === false && m.minMacos === MIN_MACOS && m.codesignVerified === true
    && !!inputs && typeof inputs === 'object' && !Array.isArray(inputs) && Object.keys(inputs).join() === SOURCE_INPUT
    && typeof inputs[SOURCE_INPUT] === 'string' && HEX64.test(inputs[SOURCE_INPUT] as string)
    && [m.binarySha256, m.fixtureSha256].every(v => typeof v === 'string' && HEX64.test(v))
    && Number.isSafeInteger(m.bytes) && (m.bytes as number) > 0 && (m.bytes as number) <= MAX_BINARY_BYTES
    && typeof m.compiler === 'string' && m.compiler.length > 0 && m.compiler.length <= 512
    && typeof m.sdk === 'string' && SDK.test(m.sdk) && Number(m.sdk.split('.')[0]) >= 15;
  if (!ok) fail('MANIFEST_FIELDS');
  return m as unknown as Manifest;
}

/** Validates <root>/runtime against <root>/platforms/macos/Preview.swift and, if present, preview-build.json. */
export function verifyMacosPreview(root: string) {
  const runtime = join(root, 'runtime');
  const directory = (() => { try { return lstatSync(runtime); } catch { return undefined; } })();
  if (!directory || !directory.isDirectory()) fail('CACHE_NOT_DIRECTORY');
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(readRegular(join(runtime, 'macos-native-build.json'), MAX_MANIFEST_BYTES, 'MANIFEST').toString('utf8')); }
  catch (error) { if (error instanceof MacPreviewCacheError) throw error; fail('MANIFEST_JSON'); }
  const manifest = validateManifest(manifestValue);
  const sourceHash = sha256(readRegular(join(root, SOURCE_INPUT), MAX_SOURCE_BYTES, 'SOURCE_INPUT'));
  if (sourceHash !== manifest.inputs[SOURCE_INPUT]) fail('SOURCE_INPUT_MISMATCH');
  let packageSource: string | null = null;
  const packageRecord = join(root, 'preview-build.json');
  if ((() => { try { lstatSync(packageRecord); return true; } catch { return false; } })()) {
    let record: { source?: unknown; files?: Record<string, unknown> } = {};
    try { record = JSON.parse(readRegular(packageRecord, 4 * 1024 * 1024, 'PACKAGE_RECORD').toString('utf8')); }
    catch (error) { if (error instanceof MacPreviewCacheError) throw error; fail('PACKAGE_RECORD_JSON'); }
    if (typeof record.source !== 'string' || !HEX40.test(record.source)) fail('PACKAGE_SOURCE_INVALID');
    packageSource = record.source as string;
    const listed = record.files?.[SOURCE_INPUT];
    if (listed !== undefined && listed !== sourceHash) fail('PACKAGE_SOURCE_INPUT_MISMATCH');
  }
  const binary = readRegular(join(runtime, 'SpindlePreview'), MAX_BINARY_BYTES, 'BINARY');
  const fixture = readRegular(join(runtime, 'SpindleFixture'), MAX_BINARY_BYTES, 'FIXTURE');
  if (binary.length !== manifest.bytes || sha256(binary) !== manifest.binarySha256) fail('BINARY_HASH_MISMATCH');
  if (!fixture.equals(binary) || manifest.fixtureSha256 !== manifest.binarySha256) fail('FIXTURE_HASH_MISMATCH');
  validateMacho(binary);
  return {
    schema: 'spindle-macos-preview-cache-check/v1', valid: true,
    check: 'structural-only', nativeExecution: 'not-run', installedAcceptance: 'not-validated',
    producerSourceRevision: manifest.sourceRevision, packageSource,
    reusedAcrossRevisions: packageSource !== null && packageSource !== manifest.sourceRevision,
    inputs: manifest.inputs, binarySha256: manifest.binarySha256,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--root');
  const root = flag >= 0 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    process.stdout.write(JSON.stringify(verifyMacosPreview(root)) + '\n');
  } catch (error) {
    // Content-free code only: no local paths or raw exceptions in launcher output.
    const code = error instanceof MacPreviewCacheError ? error.message : 'VERIFY_IO_ERROR';
    process.stdout.write(JSON.stringify({ schema: 'spindle-macos-preview-cache-check/v1', valid: false, code }) + '\n');
    process.exitCode = 2;
  }
}
