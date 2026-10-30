#!/usr/bin/env python3
"""Produce or verify the precompiled macOS arm64 Preview helper cache.

Build mode runs only on a Mac with already-installed Command Line Tools: it uses
the same swiftc target/frameworks and ad-hoc codesign as start-preview.command,
binds the clean source revision/tree and Preview.swift hash, and never runs the
helper, changes privacy/security settings or installs tools. --verify-cache is a
pure structural check that runs anywhere; it is not native build or execution
evidence. Python 3.9 compatible (the CLT python3).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'spindle-macos-preview-native/v1'
TARGET = 'macos-arm64'
MIN_MACOS = '15.0'
SOURCE_INPUT = 'platforms/macos/Preview.swift'
MANIFEST = 'macos-native-build.json'
BINARY, FIXTURE = 'SpindlePreview', 'SpindleFixture'
MANIFEST_KEYS = {'schema', 'target', 'sourceRevision', 'sourceTree', 'sourceDirty', 'inputs', 'binarySha256', 'fixtureSha256', 'bytes', 'compiler', 'sdk', 'minMacos', 'codesignVerified'}
MAX_BINARY_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_SOURCE_BYTES = 4 * 1024 * 1024
FRAMEWORKS = ['AppKit', 'ApplicationServices', 'ScreenCaptureKit', 'Vision', 'CoreImage', 'Security']
# Mach-O constants (<mach-o/loader.h>, <mach/machine.h>).
MH_MAGIC_64, CPU_TYPE_ARM64, MH_EXECUTE = 0xFEEDFACF, 0x0100000C, 2
LC_CODE_SIGNATURE, LC_BUILD_VERSION, PLATFORM_MACOS = 0x1D, 0x32, 1
HEX40, HEX64 = re.compile(r'[0-9a-f]{40}'), re.compile(r'[0-9a-f]{64}')


class CacheError(ValueError):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, limit, code):
    """Read a regular, non-symlink file without following a swapped link."""
    try:
        info = os.lstat(str(path))
    except FileNotFoundError:
        raise CacheError(code + '_MISSING')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise CacheError(code + '_NOT_REGULAR')
    if info.st_size > limit:
        raise CacheError(code + '_OVERSIZE')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(str(path), flags)
    with os.fdopen(descriptor, 'rb') as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise CacheError(code + '_OVERSIZE')
    return data


def macho_version(value):
    return '%d.%d' % (value >> 16, (value >> 8) & 0xFF) + ('.%d' % (value & 0xFF) if value & 0xFF else '')


def validate_macho(data, minimum=MIN_MACOS):
    """Thin 64-bit arm64 MH_EXECUTE with macOS LC_BUILD_VERSION minos and a signature blob."""
    if len(data) < 32:
        raise CacheError('MACHO_TRUNCATED')
    magic, cputype, _subtype, filetype, ncmds, sizeofcmds = struct.unpack_from('<IiiIII', data, 0)
    if magic != MH_MAGIC_64:
        raise CacheError('MACHO_NOT_THIN_64')
    if cputype != CPU_TYPE_ARM64:
        raise CacheError('MACHO_ARCHITECTURE_MISMATCH')
    if filetype != MH_EXECUTE:
        raise CacheError('MACHO_NOT_EXECUTABLE')
    if 32 + sizeofcmds > len(data):
        raise CacheError('MACHO_TRUNCATED')
    offset, end, build, signed = 32, 32 + sizeofcmds, None, False
    for _ in range(ncmds):
        if offset + 8 > end:
            raise CacheError('MACHO_LOAD_COMMANDS')
        cmd, size = struct.unpack_from('<II', data, offset)
        if size < 8 or offset + size > end:
            raise CacheError('MACHO_LOAD_COMMANDS')
        if cmd == LC_BUILD_VERSION:
            if size < 24 or build is not None:
                raise CacheError('MACHO_BUILD_VERSION')
            build = struct.unpack_from('<II', data, offset + 8)
        elif cmd == LC_CODE_SIGNATURE:
            signed = True
        offset += size
    if build is None or build[0] != PLATFORM_MACOS:
        raise CacheError('MACHO_PLATFORM_MISMATCH')
    if macho_version(build[1]) != minimum:
        raise CacheError('MACHO_MINIMUM_OS_MISMATCH')
    if not signed:
        raise CacheError('MACHO_UNSIGNED')


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or set(manifest) != MANIFEST_KEYS:
        raise CacheError('MANIFEST_KEYS')
    checks = [
        manifest['schema'] == SCHEMA, manifest['target'] == TARGET,
        isinstance(manifest['sourceRevision'], str) and HEX40.fullmatch(manifest['sourceRevision']),
        isinstance(manifest['sourceTree'], str) and HEX40.fullmatch(manifest['sourceTree']),
        manifest['sourceDirty'] is False, manifest['minMacos'] == MIN_MACOS,
        manifest['codesignVerified'] is True,
        isinstance(manifest['inputs'], dict) and set(manifest['inputs']) == {SOURCE_INPUT},
        all(isinstance(manifest[k], str) and HEX64.fullmatch(manifest[k]) for k in ('binarySha256', 'fixtureSha256')),
        isinstance(manifest['bytes'], int) and not isinstance(manifest['bytes'], bool) and 0 < manifest['bytes'] <= MAX_BINARY_BYTES,
        isinstance(manifest['compiler'], str) and 0 < len(manifest['compiler']) <= 512,
        isinstance(manifest['sdk'], str) and re.fullmatch(r'\d+(\.\d+){0,2}', manifest['sdk']) and int(manifest['sdk'].split('.')[0]) >= 15,
    ]
    if not all(checks):
        raise CacheError('MANIFEST_FIELDS')
    if not (isinstance(manifest['inputs'][SOURCE_INPUT], str) and HEX64.fullmatch(manifest['inputs'][SOURCE_INPUT])):
        raise CacheError('MANIFEST_FIELDS')


def verify_cache(cache, source_root=ROOT, package_source=None, exact_entries=True):
    """Structural check of a cache directory against the package's Preview.swift.

    package_source names the package revision; a different producer revision is
    accepted only because the actual Swift input hash matches, and is reported.
    """
    cache = Path(cache)
    info = os.lstat(str(cache)) if os.path.lexists(str(cache)) else None
    if info is None or not stat.S_ISDIR(info.st_mode):
        raise CacheError('CACHE_NOT_DIRECTORY')
    if exact_entries and sorted(os.listdir(str(cache))) != sorted([BINARY, FIXTURE, MANIFEST]):
        raise CacheError('CACHE_UNEXPECTED_ENTRIES')
    raw = read_regular(cache / MANIFEST, MAX_MANIFEST_BYTES, 'MANIFEST')
    try:
        manifest = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise CacheError('MANIFEST_JSON')
    validate_manifest(manifest)
    source = read_regular(Path(source_root) / SOURCE_INPUT, MAX_SOURCE_BYTES, 'SOURCE_INPUT')
    if sha256(source) != manifest['inputs'][SOURCE_INPUT]:
        raise CacheError('SOURCE_INPUT_MISMATCH')
    binary = read_regular(cache / BINARY, MAX_BINARY_BYTES, 'BINARY')
    fixture = read_regular(cache / FIXTURE, MAX_BINARY_BYTES, 'FIXTURE')
    if len(binary) != manifest['bytes'] or sha256(binary) != manifest['binarySha256']:
        raise CacheError('BINARY_HASH_MISMATCH')
    if fixture != binary or manifest['fixtureSha256'] != manifest['binarySha256']:
        raise CacheError('FIXTURE_HASH_MISMATCH')
    validate_macho(binary)
    if package_source is not None and not HEX40.fullmatch(package_source):
        raise CacheError('PACKAGE_SOURCE_INVALID')
    return {
        'schema': 'spindle-macos-preview-cache-check/v1', 'valid': True,
        'check': 'structural-only', 'nativeExecution': 'not-run', 'installedAcceptance': 'not-validated',
        'producerSourceRevision': manifest['sourceRevision'], 'packageSource': package_source,
        'reusedAcrossRevisions': package_source is not None and package_source != manifest['sourceRevision'],
        'inputs': manifest['inputs'], 'binarySha256': manifest['binarySha256'],
    }


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=str(root), text=True).strip()


def tool_output(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()


def build(output, root=ROOT, xcrun='/usr/bin/xcrun', codesign='/usr/bin/codesign', host=None):
    """Compile, ad-hoc sign and record a cache; never executes the helper."""
    root, output = Path(root).resolve(), Path(output)
    if (host or os.uname().sysname) != 'Darwin':
        raise CacheError('MAC_BUILD_HOST_REQUIRED')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        raise CacheError('SOURCE_DIRTY')
    revision, tree = git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'HEAD^{tree}')
    if os.path.lexists(str(output)) and (os.path.islink(str(output)) or not output.is_dir() or any(output.iterdir())):
        raise CacheError('OUTPUT_EXISTS')
    sdk = tool_output([xcrun, '--sdk', 'macosx', '--show-sdk-version'])
    if not re.fullmatch(r'\d+(\.\d+){0,2}', sdk) or int(sdk.split('.')[0]) < 15:
        raise CacheError('MAC_SDK_15_REQUIRED')
    compiler = tool_output([xcrun, 'swiftc', '--version']).splitlines()[0][:512]
    source = read_regular(root / SOURCE_INPUT, MAX_SOURCE_BYTES, 'SOURCE_INPUT')
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.macos-native-', dir=str(output.parent)))
    try:
        work = staging / 'work'; cache = staging / 'cache'
        work.mkdir(); cache.mkdir()
        # Same bytes that are hashed are compiled; top-level code needs main.swift.
        (work / 'main.swift').write_bytes(source)
        binary_path = cache / BINARY
        command = [xcrun, 'swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos' + MIN_MACOS, str(work / 'main.swift'), '-o', str(binary_path)]
        for framework in FRAMEWORKS:
            command += ['-framework', framework]
        subprocess.run(command, check=True)
        subprocess.run([codesign, '--force', '--sign', '-', str(binary_path)], check=True)
        subprocess.run([codesign, '--verify', '--strict', str(binary_path)], check=True)
        binary = read_regular(binary_path, MAX_BINARY_BYTES, 'BINARY')
        validate_macho(binary)
        (cache / FIXTURE).write_bytes(binary)
        os.chmod(str(cache / FIXTURE), 0o755)
        if git(root, 'rev-parse', 'HEAD') != revision or git(root, 'status', '--porcelain', '--untracked-files=all'):
            raise CacheError('SOURCE_CHANGED_DURING_BUILD')
        manifest = {
            'schema': SCHEMA, 'target': TARGET, 'sourceRevision': revision, 'sourceTree': tree, 'sourceDirty': False,
            'inputs': {SOURCE_INPUT: sha256(source)}, 'binarySha256': sha256(binary), 'fixtureSha256': sha256(binary),
            'bytes': len(binary), 'compiler': compiler, 'sdk': sdk, 'minMacos': MIN_MACOS, 'codesignVerified': True,
        }
        (cache / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        verify_cache(cache, root, revision)
        if output.exists():
            output.rmdir()
        os.replace(str(cache), str(output))
    finally:
        shutil.rmtree(str(staging), ignore_errors=True)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/macos-native-cache', help='new or empty cache directory')
    parser.add_argument('--verify-cache', type=Path, metavar='CACHE', help='structural check only; no compile or execution')
    parser.add_argument('--package-source', help='40-hex package revision for transparent cross-revision reuse (default: HEAD)')
    args = parser.parse_args(argv)
    try:
        if args.verify_cache:
            package_source = args.package_source or git(ROOT, 'rev-parse', 'HEAD')
            result = verify_cache(args.verify_cache, ROOT, package_source)
        else:
            result = build(args.output)
    except CacheError as error:
        print(json.dumps({'valid': False, 'code': str(error)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
