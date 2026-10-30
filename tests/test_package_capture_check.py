"""Offline checks for the human-review package boundary, not native acceptance."""
import hashlib
import io
import json
from tempfile import TemporaryDirectory
from unittest.mock import patch
from pathlib import Path
import tarfile
import unittest
import zipfile

from tools import package_capture_check
from tools.package_capture_check import extract_runtime, verified_download, package_files


class PackageTests(unittest.TestCase):
    def test_corrupt_runtime_is_rejected_before_use(self):
        with self.assertRaisesRegex(ValueError, 'CHECKSUM_MISMATCH'):
            verified_download(b'corrupt', '0' * 64)
        content = b'official runtime fixture'
        self.assertEqual(verified_download(content, hashlib.sha256(content).hexdigest()), content)

    def test_extract_only_known_binary_and_license_not_archive_paths(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('node-test-win-x64/node.exe', b'EXE')
            archive.writestr('node-test-win-x64/LICENSE', b'notice')
            archive.writestr('../../escape', b'never extracted')
        binary, license_text = extract_runtime(stream.getvalue(), 'node-test-win-x64.zip')
        self.assertEqual((binary, license_text), (b'EXE', b'notice'))
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            for name, content in [('node-test-darwin-arm64/bin/node', b'BIN'), ('node-test-darwin-arm64/LICENSE', b'notice')]:
                info = tarfile.TarInfo(name); info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        self.assertEqual(extract_runtime(stream.getvalue(), 'node-test-darwin-arm64.tar.gz'), (b'BIN', b'notice'))

    def test_packaged_guide_preserves_utf8_with_a_cp1252_host_default(self):
        read_text = Path.read_text

        def host_read_text(path, encoding=None, errors=None):
            return read_text(path, encoding=encoding or 'cp1252', errors=errors)

        with TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ['contracts', 'docs', 'platforms/macos', '.local/package-cache']:
                (root / folder).mkdir(parents=True)
            guide = 'Switch A → B — then inspect the visit.\n'
            (root / 'docs/TRY_CAPTURE.md').write_bytes(guide.encode('utf-8'))
            (root / 'platforms/macos/start-capture-check.command').write_bytes(b'#!/bin/sh\n')
            (root / 'contracts/capture-check.package.json').write_bytes(json.dumps({'files': ['docs/TRY_CAPTURE.md']}).encode('utf-8'))
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                for name, content in [('node-test/bin/node', b'BIN'), ('node-test/LICENSE', b'notice')]:
                    info = tarfile.TarInfo(name); info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            content = stream.getvalue()
            (root / '.local/package-cache/node-test.tar.gz').write_bytes(content)
            lock = {'version': 'test', 'targets': {'macos-arm64': {'archive': 'node-test.tar.gz', 'sha256': hashlib.sha256(content).hexdigest()}}}
            (root / 'contracts/node-runtime.lock.json').write_bytes(json.dumps(lock).encode('utf-8'))
            args = ['package_capture_check', '--target', 'macos-arm64', '--output', str(root / 'output')]
            with patch.object(package_capture_check, 'ROOT', root), patch('sys.argv', args), patch.object(Path, 'read_text', host_read_text), patch.object(package_capture_check.subprocess, 'check_output', side_effect=['', 'a' * 40, '1609459200']), patch.object(package_capture_check.subprocess, 'run') as build:
                # Synthetic packaging test does not invoke a compiler in its fake root.
                package_capture_check.main()
            build.assert_called_once_with(['npm.cmd' if package_capture_check.os.name == 'nt' else 'npm', 'run', 'build'], cwd=root, check=True)
            with zipfile.ZipFile(next((root / 'output').glob('*.zip'))) as archive:
                name = next(name for name in archive.namelist() if name.endswith('/READ ME FIRST.txt'))
                self.assertTrue(archive.read(name).decode('utf-8').endswith(guide))

    def test_review_manifest_has_no_local_data_or_development_dependencies(self):
        root = Path(__file__).resolve().parents[1]
        files = package_files(root)
        self.assertIn('core/capture-check/ui.ts', files)
        self.assertIn('build/core/capture-check/ui.js', files)
        self.assertIn('platforms/macos/CaptureCheck.swift', files)
        self.assertIn('platforms/windows/CaptureCheck.cs', files)
        self.assertTrue(all((root / f).is_file() for f in files))
        self.assertFalse(any(part in {'.local', 'node_modules', '.git', 'tests'} for f in files for part in Path(f).parts))


if __name__ == '__main__':
    unittest.main()
