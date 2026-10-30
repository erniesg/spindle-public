"""Tool-input integrity checks; these do not establish native execution."""
import base64
import hashlib
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from build_windows_preview import verify_archive, extract_archive


class NativeBuildTests(unittest.TestCase):
    def test_modified_or_truncated_compiler_archive_is_rejected(self):
        data = b'invented archive bytes'
        package = {'id': 'invented', 'bytes': len(data), 'sha512': base64.b64encode(hashlib.sha512(data).digest()).decode()}
        self.assertEqual(verify_archive(data, package), data)
        for bad in [data[:-1], b'X' + data[1:]]:
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                verify_archive(bad, package)

    def test_archive_paths_are_validated_before_extracting_any_member(self):
        for name in ['../escape', '/absolute', 'C:/drive', r'..\escape']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = io.BytesIO()
                with zipfile.ZipFile(archive, 'w') as bundle:
                    bundle.writestr('first.txt', 'invented')
                    bundle.writestr(name, 'invented')
                archive.seek(0)
                with self.assertRaisesRegex(ValueError, 'ARCHIVE_PATH'):
                    extract_archive(archive, Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])
