"""Precompiled Mac package assembly and packaged launcher ordering, STRUCTURAL ONLY.

Every Mach-O here is a SYNTHETIC header (tests/test_macos_preview_native.py), NOT
A REAL MAC BINARY. runtime/node is a SYNTHETIC wrapper over this host's Node, not
the bundled Mac Node, and uname/sw_vers/xcrun/codesign/shasum are SYNTHETIC
stand-ins on Linux. These checks prove payload contents and launcher decisions,
not a Mac build, helper execution, permissions or installed acceptance.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'tests'))
import package_preview
import build_macos_preview as mac
from test_macos_preview_native import synthetic_macho, write_cache

PACKAGE_SOURCE = 'c' * 40  # differs from the synthetic producer revision 'a'*40
SWIFT = (ROOT / mac.SOURCE_INPUT).read_bytes()
BUILT = (ROOT / 'build/tools/verify-macos-preview.js').is_file() and (ROOT / 'build/core/preview/app.js').is_file()
STAGED = object()
SYNTHETIC_NODE = b'#!/bin/bash\n# SYNTHETIC stand-in for bundled Mac Node.\nprintf \'%s\\n\' "$*" >>"$SYNTH_LOG/bundled-node"\nexec "$REAL_NODE" --max-old-space-size=256 "$@"\n'
FAKE_TOOLS = {
    'uname': 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac',
    'sw_vers': 'echo 15.1',
    'xcrun': 'printf \'%s\\n\' "$*" >>"$SYNTH_LOG/xcrun"\n[[ -n "${SOURCE_XCRUN:-}" ]] || exit 1\ncase "$*" in --find*) echo swiftc;; *show-sdk-version) echo 15.2;; "swiftc --version") echo synthetic;; *) prev=""; for a in "$@"; do [[ "$prev" == -o ]] && cp "$SYNTH_MACHO" "$a"; prev="$a"; done;; esac',
    'codesign': 'printf \'%s\\n\' "$*" >>"$SYNTH_LOG/codesign"\nexit "${CODESIGN_STATUS:-0}"',
    'shasum': 'shift 2; exec sha256sum "$@"',
    'node': 'printf \'%s\\n\' "$*" >>"$SYNTH_LOG/ambient-node"\nexit 97',
}


class Fixture(unittest.TestCase):
    def setUp(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        self.base = Path(tempfile.mkdtemp(prefix='mac-package-', dir=ROOT / '.local'))
        self.addCleanup(shutil.rmtree, self.base)
        self.cache = self.base / 'cache'
        write_cache(self.cache, source=SWIFT)

    def main(self, *argv, git_source=PACKAGE_SOURCE):
        """Run package_preview.main with every build/download/staging effect replaced by recorders."""
        runs, outputs = [], {('git', 'status', '--porcelain'): '', ('git', 'rev-parse', 'HEAD'): git_source}
        def staged():
            raise RuntimeError('STAGING_REACHED')
        with mock.patch.object(package_preview.subprocess, 'check_output', side_effect=lambda c, **k: outputs[tuple(c)]), \
             mock.patch.object(package_preview.subprocess, 'run', side_effect=lambda c, **k: runs.append([str(x) for x in c])), \
             mock.patch.object(package_preview, 'clear_generated_build') as clear, \
             mock.patch.object(package_preview, 'urlopen', side_effect=AssertionError('download attempted')), \
             mock.patch.object(package_preview, 'package_files', side_effect=staged) as files, \
             mock.patch.object(sys, 'argv', ['package_preview.py', *argv, '--output', str(self.base / 'out')]):
            try:
                package_preview.main()
                outcome = None
            except RuntimeError as error:
                outcome = STAGED if str(error) == 'STAGING_REACHED' else error
            except SystemExit as error:
                outcome = error
        return outcome, runs, clear.called or files.called


class PackagerTargetTests(Fixture):
    def test_macos_only_target_needs_no_windows_input_and_windows_only_needs_no_mac_cache(self):
        outcome, runs, _ = self.main('--target', 'macos-arm64', '--macos-native-cache', str(self.cache))
        self.assertIs(outcome, STAGED)
        self.assertFalse(any('dotnet' in ' '.join(r) or 'build_windows_preview.py' in ' '.join(r) for r in runs), runs)
        with mock.patch.object(package_preview, 'verify_cache', side_effect=AssertionError('Mac cache demanded')):
            outcome, runs, _ = self.main('--target', 'windows-x64', '--windows-native-cache', str(self.base / 'win'))
        self.assertIs(outcome, STAGED)
        self.assertTrue(any(r[1].endswith('tools/build_windows_preview.py') for r in runs), runs)

    def test_missing_or_invalid_mac_cache_fails_before_build_download_or_staging(self):
        outcome, runs, touched = self.main('--target', 'macos-arm64')
        self.assertIsInstance(outcome, SystemExit)
        self.assertEqual((runs, touched), ([], False))
        (self.cache / 'SpindlePreview').write_bytes(synthetic_macho() + b'tampered')
        outcome, runs, touched = self.main('--target', 'macos-arm64', '--macos-native-cache', str(self.cache))
        self.assertIsInstance(outcome, SystemExit)
        self.assertEqual(str(outcome), 'MAC_NATIVE_CACHE_INVALID: BINARY_HASH_MISMATCH')
        self.assertEqual((runs, touched), ([], False))


@unittest.skipUnless(BUILT and shutil.which('node') and shutil.which('sha256sum'), 'npm run build first; needs node and sha256sum')
class PrecompiledPackageTests(Fixture):
    def build_zip(self):
        loaded = package_preview.load_macos_cache(self.cache, PACKAGE_SOURCE)
        files = package_preview.target_files('macos-arm64', package_preview.package_files(), SYNTHETIC_NODE, b'synthetic licence', PACKAGE_SOURCE, None, loaded)
        out = self.base / 'package.zip'
        name = package_preview.write_package(out, 'SpindleCapturePreview-macos-arm64-test', files, (2026, 1, 1, 0, 0, 0))
        return out, name, files

    def extract(self, label):
        """Extract applying ZIP Unix modes, as Archive Utility/unzip do."""
        out, name, _ = self.build_zip()
        target = self.base / label
        with zipfile.ZipFile(out) as bundle:
            for info in bundle.infolist():
                path = target / info.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bundle.read(info))
                os.chmod(path, (info.external_attr >> 16) & 0o777)
        package = target / name
        (package / 'build/core/preview/app.js').write_text('console.log(JSON.stringify(["SYNTHETIC APP", ...process.argv.slice(2)]));\n')
        return package

    def launch(self, launcher, cwd, **env):
        """Run the ACTUAL launcher text with /usr/bin tools redirected to synthetic stand-ins."""
        tools, log = self.base / 'synthetic-bin', self.base / 'logs'
        shutil.rmtree(log, ignore_errors=True); log.mkdir()
        if not tools.exists():
            tools.mkdir()
            for tool, body in FAKE_TOOLS.items():
                (tools / tool).write_text('#!/bin/bash\n' + body + '\n'); (tools / tool).chmod(0o755)
        text = launcher.read_text()
        self.assertGreater(text.count('/usr/bin/'), 0)
        launcher.write_text(text.replace('/usr/bin/', str(tools) + '/'))
        (self.base / 'macho').write_bytes(synthetic_macho())
        environment = {'PATH': f'{tools}:/usr/bin:/bin', 'HOME': str(self.base), 'SYNTH_LOG': str(log), 'REAL_NODE': shutil.which('node'), 'SYNTH_MACHO': str(self.base / 'macho'), **env}
        result = subprocess.run(['bash', str(launcher), '--no-open'], cwd=cwd, env=environment, capture_output=True, text=True, timeout=60)
        logs = {p.name: p.read_text() for p in log.iterdir()}
        return result, logs

    def test_precompiled_payload_carries_cache_validator_exec_bits_and_honest_record(self):
        out, name, files = self.build_zip()
        with zipfile.ZipFile(out) as bundle:
            modes = {i.filename[len(name) + 1:]: (i.external_attr >> 16) & 0o777 for i in bundle.infolist()}
        for path in ['runtime/SpindlePreview', 'runtime/SpindleFixture', 'runtime/node', 'Start Spindle Preview.command']:
            self.assertEqual(modes[path], 0o755, path)
        for path in ['runtime/macos-native-build.json', 'build/tools/verify-macos-preview.js', mac.SOURCE_INPUT]:
            self.assertEqual(modes[path], 0o644, path)
        self.assertEqual(files['runtime/SpindlePreview'], (self.cache / 'SpindlePreview').read_bytes())
        self.assertEqual(files['runtime/SpindleFixture'], files['runtime/SpindlePreview'])
        self.assertEqual(files['runtime/macos-native-build.json'], (self.cache / mac.MANIFEST).read_bytes())
        record = json.loads(files['preview-build.json'])
        self.assertEqual((record['nativeBuild'], record['nativeExecution'], record['installedAcceptance']), ('macos-precompiled-cache', 'not-run', 'not-validated'))
        self.assertEqual(record['files']['runtime/SpindlePreview'], hashlib.sha256(files['runtime/SpindlePreview']).hexdigest())
        cache = record['macosNativeCache']
        self.assertEqual((cache['check'], cache['producerSourceRevision'], cache['packageSource'], cache['reusedAcrossRevisions'], cache['producerRecord']),
                         ('structural-only', 'a' * 40, PACKAGE_SOURCE, True, 'unattested-producer-metadata'))
        readme = files['READ ME FIRST.txt'].decode()
        self.assertNotIn('Mac needs CLT', readme.split('\n\n', 1)[0])
        self.assertIn('precompiled', readme.split('\n\n', 1)[0])

    def test_packaged_launcher_checks_cache_with_bundled_node_and_never_compiles_or_uses_ambient_node(self):
        package = self.extract('valid')
        result, logs = self.launch(package / 'Start Spindle Preview.command', package)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]), ['SYNTHETIC APP', '--no-open'])
        calls = logs['bundled-node'].splitlines()
        self.assertIn('build/tools/verify-macos-preview.js --root', calls[0])
        self.assertIn('build/core/preview/app.js', calls[1])
        self.assertNotIn('xcrun', logs); self.assertNotIn('ambient-node', logs)
        self.assertEqual(logs['codesign'].split(), ['--verify', '--strict', str(package / 'runtime/SpindlePreview')])
        failures = {
            'MAC_NATIVE_CACHE_INVALID': lambda p: (p / 'runtime/SpindlePreview').write_bytes(synthetic_macho() + b'x'),
            'MAC_NATIVE_CACHE_REQUIRED': lambda p: (p / 'runtime/macos-native-build.json').unlink(),
            'BUNDLED_NODE_REQUIRED': lambda p: (p / 'runtime/node').unlink(),
            'MAC_PACKAGE_INCOMPLETE': lambda p: (p / 'preview-build.json').unlink(),
        }
        for code, tamper in failures.items():
            with self.subTest(code=code):
                package = self.extract(code)
                tamper(package)
                result, logs = self.launch(package / 'Start Spindle Preview.command', package)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertEqual(json.loads((package / '.local/launcher-feedback.json').read_text())['code'], code)
                self.assertNotIn('SYNTHETIC APP', result.stdout)
                self.assertNotIn('xcrun', logs); self.assertNotIn('ambient-node', logs)
                self.assertFalse((package / 'runtime/SpindlePreview.tmp').exists())
        check = json.loads(next((self.base / 'MAC_NATIVE_CACHE_INVALID').glob('*/.local/macos-native-check.json')).read_text())
        self.assertEqual((check['valid'], check['code']), (False, 'BINARY_HASH_MISMATCH'))
        package = self.extract('signature')
        result, logs = self.launch(package / 'Start Spindle Preview.command', package, CODESIGN_STATUS='1')
        self.assertEqual((result.returncode, json.loads((package / '.local/launcher-feedback.json').read_text())['code']), (2, 'MAC_NATIVE_SIGNATURE_INVALID'))
        self.assertNotIn('xcrun', logs)

    def test_only_recognised_source_checkout_keeps_local_compile(self):
        checkout = self.base / 'checkout'
        (checkout / '.git').mkdir(parents=True)
        (checkout / 'platforms/macos').mkdir(parents=True)
        (checkout / 'build/core/preview').mkdir(parents=True)
        (checkout / 'runtime').mkdir()
        (checkout / 'package.json').write_text('{"private":true,"type":"module"}\n')
        (checkout / mac.SOURCE_INPUT).write_bytes(SWIFT)
        (checkout / 'build/core/preview/app.js').write_text('console.log(JSON.stringify(["SYNTHETIC APP"]));\n')
        (checkout / 'runtime/node').write_bytes(SYNTHETIC_NODE); (checkout / 'runtime/node').chmod(0o755)
        launcher = checkout / 'platforms/macos/start-preview.command'
        shutil.copyfile(ROOT / 'platforms/macos/start-preview.command', launcher)
        result, logs = self.launch(launcher, checkout, SOURCE_XCRUN='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('swiftc -swift-version 5 -O -target arm64-apple-macos15.0', logs['xcrun'])
        self.assertTrue((checkout / 'runtime/SpindlePreview').is_file())
        shutil.rmtree(checkout / '.git')  # same tree, but no longer a recognised checkout
        (checkout / 'runtime/SpindlePreview').unlink()
        shutil.copyfile(ROOT / 'platforms/macos/start-preview.command', launcher)
        result, logs = self.launch(launcher, checkout, SOURCE_XCRUN='1')
        self.assertEqual((result.returncode, json.loads((checkout / '.local/launcher-feedback.json').read_text())['code']), (2, 'MAC_PACKAGE_INCOMPLETE'))
        self.assertNotIn('xcrun', logs)


if __name__ == '__main__':
    unittest.main()
