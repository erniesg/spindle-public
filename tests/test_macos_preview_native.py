"""Precompiled Mac helper cache producer/validator checks.

Every binary here is a SYNTHETIC Mach-O header written by this test, NOT A REAL
MAC BINARY: these checks prove structural cache validation and producer
binding on any host, not Mac compilation, signing, execution or acceptance.
"""
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import build_macos_preview as mac
from build_macos_preview import CacheError, verify_cache, build

NODE_VERIFIER = ROOT / 'build/tools/verify-macos-preview.js'
SOURCE = b'// invented Preview.swift stand-in for cache tests\nprint("SPINDLE INVENTED")\n'
ARM64, X86_64 = 0x0100000C, 0x01000007


def synthetic_macho(cputype=ARM64, minos=0x000F0000, platform=1, signed=True, magic=0xFEEDFACF, filetype=2):
    """SYNTHETIC header + LC_BUILD_VERSION (+ LC_CODE_SIGNATURE); not executable code."""
    commands = struct.pack('<IIIIII', 0x32, 24, platform, minos, 0x000F0000, 0)
    if signed:
        commands += struct.pack('<IIII', 0x1D, 16, 4096, 16)
    ncmds = 2 if signed else 1
    header = struct.pack('<IiiIIIII', magic, cputype, 0, filetype, ncmds, len(commands), 0, 0)
    return header + commands + b'SYNTHETIC-NOT-A-REAL-MAC-BINARY'.ljust(64, b'\0')


def write_cache(directory, binary=None, source=SOURCE, revision='a' * 40, **overrides):
    binary = synthetic_macho() if binary is None else binary
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'SpindlePreview').write_bytes(binary)
    (directory / 'SpindleFixture').write_bytes(binary)
    manifest = {
        'schema': mac.SCHEMA, 'target': 'macos-arm64', 'sourceRevision': revision, 'sourceTree': 'b' * 40,
        'sourceDirty': False, 'inputs': {mac.SOURCE_INPUT: hashlib.sha256(source).hexdigest()},
        'binarySha256': hashlib.sha256(binary).hexdigest(), 'fixtureSha256': hashlib.sha256(binary).hexdigest(),
        'bytes': len(binary), 'compiler': 'synthetic test compiler', 'sdk': '15.2', 'minMacos': '15.0', 'codesignVerified': True,
    }
    manifest.update(overrides)
    (directory / mac.MANIFEST).write_text(json.dumps(manifest))
    return manifest


class Package:
    """Package-shaped tree: runtime/ cache entries beside packaged Preview.swift."""
    def __init__(self, base, package_source=None):
        self.root = base / 'package'
        (self.root / 'platforms/macos').mkdir(parents=True)
        (self.root / mac.SOURCE_INPUT).write_bytes(SOURCE)
        self.runtime = self.root / 'runtime'
        self.manifest = write_cache(self.runtime)
        (self.runtime / 'node').write_bytes(b'invented bundled node placeholder')
        if package_source:
            (self.root / 'preview-build.json').write_text(json.dumps({'source': package_source, 'files': {mac.SOURCE_INPUT: hashlib.sha256(SOURCE).hexdigest()}}))

    def python(self):
        # Package runtime/ legitimately holds node/licence beside the cache.
        return verify_cache(self.runtime, self.root, None, exact_entries=False)

    def node(self):
        result = subprocess.run(['node', '--max-old-space-size=256', str(NODE_VERIFIER), '--root', str(self.root)], capture_output=True, text=True)
        return result.returncode, json.loads(result.stdout)


@unittest.skipUnless(NODE_VERIFIER.is_file(), 'run npm run build first (make check builds before unittest)')
class CacheValidationTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        self.base = Path(tempfile.mkdtemp(dir=ROOT / '.local'))
        self.addCleanup(shutil.rmtree, self.base)

    def assertBothReject(self, package, code):
        with self.assertRaisesRegex(CacheError, '^' + code + '$'):
            package.python()
        status, result = package.node()
        self.assertEqual((status, result['valid'], result['code']), (2, False, code))

    def test_valid_synthetic_cache_is_structural_only_in_python_and_node(self):
        package = Package(self.base)
        expected = {'valid': True, 'check': 'structural-only', 'nativeExecution': 'not-run', 'installedAcceptance': 'not-validated', 'binarySha256': package.manifest['binarySha256']}
        self.assertLessEqual(expected.items(), package.python().items())
        status, result = package.node()
        self.assertEqual(status, 0)
        self.assertLessEqual(expected.items(), result.items())

    def test_different_producer_revision_reuse_is_reported_only_when_swift_input_matches(self):
        package = Package(self.base, package_source='c' * 40)
        status, result = package.node()
        self.assertEqual((status, result['producerSourceRevision'], result['packageSource'], result['reusedAcrossRevisions']), (0, 'a' * 40, 'c' * 40, True))
        self.assertTrue(verify_cache(package.runtime, package.root, 'c' * 40, exact_entries=False)['reusedAcrossRevisions'])
        (package.root / mac.SOURCE_INPUT).write_bytes(SOURCE + b'// changed package source\n')
        self.assertBothReject(package, 'SOURCE_INPUT_MISMATCH')

    def test_packaged_record_listing_another_swift_hash_is_rejected(self):
        package = Package(self.base, package_source='c' * 40)
        (package.root / 'preview-build.json').write_text(json.dumps({'source': 'c' * 40, 'files': {mac.SOURCE_INPUT: 'd' * 64}}))
        status, result = package.node()
        self.assertEqual((status, result['code']), (2, 'PACKAGE_SOURCE_INPUT_MISMATCH'))

    def test_binary_mismatches_are_rejected(self):
        cases = {
            'MACHO_ARCHITECTURE_MISMATCH': synthetic_macho(cputype=X86_64),
            'MACHO_NOT_THIN_64': synthetic_macho(magic=0xCAFEBABE),
            'MACHO_NOT_EXECUTABLE': synthetic_macho(filetype=6),
            'MACHO_PLATFORM_MISMATCH': synthetic_macho(platform=2),
            'MACHO_MINIMUM_OS_MISMATCH': synthetic_macho(minos=0x000E0000),
            'MACHO_UNSIGNED': synthetic_macho(signed=False),
            'MACHO_TRUNCATED': synthetic_macho()[:20],
        }
        for code, binary in cases.items():
            with self.subTest(code=code):
                package = Package(self.base / code)
                write_cache(package.runtime, binary)
                self.assertBothReject(package, code)

    def test_tampered_or_mismatched_records_are_rejected(self):
        cases = [
            ('BINARY_HASH_MISMATCH', lambda p: (p.runtime / 'SpindlePreview').write_bytes(synthetic_macho() + b'x')),
            ('FIXTURE_HASH_MISMATCH', lambda p: (p.runtime / 'SpindleFixture').write_bytes(synthetic_macho(minos=0x000F0100))),
            ('MANIFEST_FIELDS', lambda p: write_cache(p.runtime, target='macos-x64')),
            ('MANIFEST_FIELDS', lambda p: write_cache(p.runtime, sourceDirty=True)),
            ('MANIFEST_FIELDS', lambda p: write_cache(p.runtime, inputs={mac.SOURCE_INPUT: hashlib.sha256(SOURCE).hexdigest(), 'platforms/macos/Other.swift': 'e' * 64})),
            ('MANIFEST_FIELDS', lambda p: write_cache(p.runtime, sdk='14.5')),
            ('MANIFEST_KEYS', lambda p: write_cache(p.runtime, nativeAcceptance='passed')),
            ('MANIFEST_JSON', lambda p: (p.runtime / mac.MANIFEST).write_text('{not json')),
        ]
        for index, (code, tamper) in enumerate(cases):
            with self.subTest(code=code, index=index):
                package = Package(self.base / str(index))
                tamper(package)
                self.assertBothReject(package, code)

    def test_symlinked_nonregular_missing_and_oversize_entries_are_rejected(self):
        package = Package(self.base / 'link')
        target = self.base / 'outside-binary'
        shutil.move(str(package.runtime / 'SpindlePreview'), str(target))
        os.symlink(str(target), str(package.runtime / 'SpindlePreview'))
        self.assertBothReject(package, 'BINARY_NOT_REGULAR')
        package = Package(self.base / 'directory')
        (package.runtime / 'SpindleFixture').unlink(); (package.runtime / 'SpindleFixture').mkdir()
        self.assertBothReject(package, 'FIXTURE_NOT_REGULAR')
        package = Package(self.base / 'source-link')
        (package.root / mac.SOURCE_INPUT).unlink(); os.symlink(str(target), str(package.root / mac.SOURCE_INPUT))
        self.assertBothReject(package, 'SOURCE_INPUT_NOT_REGULAR')
        package = Package(self.base / 'missing')
        (package.runtime / mac.MANIFEST).unlink()
        self.assertBothReject(package, 'MANIFEST_MISSING')
        package = Package(self.base / 'oversize')
        with open(str(package.runtime / 'SpindlePreview'), 'r+b') as handle:
            handle.truncate(mac.MAX_BINARY_BYTES + 1)  # sparse; never read past the limit
        self.assertBothReject(package, 'BINARY_OVERSIZE')

    def test_strict_cache_directory_rejects_extra_entries_and_symlinked_directory(self):
        cache = self.base / 'cache'; write_cache(cache)
        (self.base / mac.SOURCE_INPUT).parent.mkdir(parents=True); (self.base / mac.SOURCE_INPUT).write_bytes(SOURCE)
        self.assertTrue(verify_cache(cache, self.base, 'a' * 40)['valid'])
        os.symlink(str(cache), str(self.base / 'linked-cache'))
        with self.assertRaisesRegex(CacheError, 'CACHE_NOT_DIRECTORY'):
            verify_cache(self.base / 'linked-cache', self.base)
        (cache / 'extra').write_bytes(b'invented')
        with self.assertRaisesRegex(CacheError, 'CACHE_UNEXPECTED_ENTRIES'):
            verify_cache(cache, self.base)


FAKE_XCRUN = '''#!/bin/bash
# SYNTHETIC stand-in for xcrun; writes a synthetic header, NOT A REAL MAC BINARY.
set -euo pipefail
if [[ "$1" == --sdk ]]; then echo "${FAKE_SDK:-15.2}"; exit 0; fi
if [[ "$2" == --version ]]; then echo "synthetic swiftc 0.0 (test)"; exit 0; fi
printf '%s\\n' "$@" >"$FAKE_LOG"
out=""; prev=""; for arg in "$@"; do [[ "$prev" == -o ]] && out="$arg"; prev="$arg"; done
cp "$FAKE_MACHO" "$out"
'''
FAKE_CODESIGN = '''#!/bin/bash
# SYNTHETIC stand-in for codesign; performs no signing.
printf '%s\\n' "$*" >>"$FAKE_SIGN_LOG"
'''


class ProducerTests(unittest.TestCase):
    """Producer binding with SYNTHETIC tool stand-ins; not a Mac build."""
    def setUp(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        self.base = Path(tempfile.mkdtemp(dir=ROOT / '.local'))
        self.addCleanup(shutil.rmtree, self.base)
        self.repo = self.base / 'repo'
        (self.repo / 'platforms/macos').mkdir(parents=True)
        (self.repo / mac.SOURCE_INPUT).write_bytes(SOURCE)
        git = lambda *a: subprocess.run(['git', '-c', 'user.name=invented', '-c', 'user.email=invented@example.invalid', *a], cwd=self.repo, check=True, capture_output=True)
        git('init', '-q'); git('add', '.'); git('commit', '-qm', 'invented')
        self.revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.repo, text=True).strip()
        tools = self.base / 'tools'; tools.mkdir()
        self.xcrun, self.codesign = tools / 'xcrun', tools / 'codesign'
        self.xcrun.write_text(FAKE_XCRUN); self.codesign.write_text(FAKE_CODESIGN)
        os.chmod(str(self.xcrun), 0o755); os.chmod(str(self.codesign), 0o755)
        (self.base / 'macho').write_bytes(synthetic_macho())
        environment = mock.patch.dict(os.environ, FAKE_MACHO=str(self.base / 'macho'), FAKE_LOG=str(self.base / 'compile.log'), FAKE_SIGN_LOG=str(self.base / 'sign.log'), FAKE_SDK='15.2')
        environment.start(); self.addCleanup(environment.stop)

    def run_build(self, output, host='Darwin'):
        return build(output, self.repo, str(self.xcrun), str(self.codesign), host)

    def test_build_requires_mac_host_without_touching_output(self):
        with self.assertRaisesRegex(CacheError, 'MAC_BUILD_HOST_REQUIRED'):
            self.run_build(self.base / 'out', host='Linux')
        self.assertFalse((self.base / 'out').exists())

    def test_build_binds_clean_source_same_compiler_flags_and_verifies_signature(self):
        manifest = self.run_build(self.base / 'out')
        self.assertEqual((manifest['sourceRevision'], manifest['inputs'], manifest['sdk'], manifest['codesignVerified']),
                         (self.revision, {mac.SOURCE_INPUT: hashlib.sha256(SOURCE).hexdigest()}, '15.2', True))
        args = (self.base / 'compile.log').read_text().split('\n')
        self.assertEqual(args[:7], ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos15.0', args[6]])
        self.assertTrue(args[6].endswith('/main.swift'))
        self.assertEqual([a for a in args if a and a != '-framework'][9:], mac.FRAMEWORKS)
        self.assertEqual((self.base / 'sign.log').read_text().split('\n')[:2], ['--force --sign - ' + args[8], '--verify --strict ' + args[8]])
        self.assertEqual(sorted(p.name for p in (self.base / 'out').iterdir()), ['SpindleFixture', 'SpindlePreview', mac.MANIFEST])
        self.assertTrue(verify_cache(self.base / 'out', self.repo, self.revision)['valid'])
        self.assertEqual([p.name for p in self.base.iterdir() if p.name.startswith('.macos-native-')], [])

    def test_build_refuses_dirty_untracked_old_sdk_existing_output_and_wrong_binary(self):
        (self.repo / 'untracked.swift').write_text('// invented')
        with self.assertRaisesRegex(CacheError, 'SOURCE_DIRTY'):
            self.run_build(self.base / 'out')
        (self.repo / 'untracked.swift').unlink()
        os.environ['FAKE_SDK'] = '14.5'
        with self.assertRaisesRegex(CacheError, 'MAC_SDK_15_REQUIRED'):
            self.run_build(self.base / 'out')
        os.environ['FAKE_SDK'] = '15.2'
        (self.base / 'existing').mkdir(); (self.base / 'existing/keep').write_text('invented')
        with self.assertRaisesRegex(CacheError, 'OUTPUT_EXISTS'):
            self.run_build(self.base / 'existing')
        self.assertEqual((self.base / 'existing/keep').read_text(), 'invented')
        (self.base / 'macho').write_bytes(synthetic_macho(cputype=X86_64))
        with self.assertRaisesRegex(CacheError, 'MACHO_ARCHITECTURE_MISMATCH'):
            self.run_build(self.base / 'out')
        self.assertFalse((self.base / 'out').exists())


if __name__ == '__main__':
    unittest.main()
