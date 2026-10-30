"""Repository invariants only; these tests do not validate capture behavior."""

from pathlib import Path
import json
import shlex
import re
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]


class RepositoryTests(unittest.TestCase):
    def test_documented_local_links_exist(self):
        for document in ROOT.rglob("*.md"):
            if any(part.startswith(".") or part == "node_modules"
                   for part in document.relative_to(ROOT).parts):
                continue
            for target in re.findall(r"\]\(([^)\s]+)\)", document.read_text(encoding='utf-8')):
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                with self.subTest(document=document.relative_to(ROOT), target=target):
                    self.assertTrue((document.parent / unquote(parsed.path)).exists())

    def test_markdown_is_utf8_even_with_a_cp1252_host_default(self):
        read_text = Path.read_text

        def host_read_text(path, encoding=None, errors=None):
            return read_text(path, encoding=encoding or 'cp1252', errors=errors)

        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_bytes('Read “the guide” → [Guide](guide.md)'.encode('utf-8'))
            (root / 'guide.md').write_bytes(b'# Guide')
            with patch(__name__ + '.ROOT', root), patch.object(Path, 'read_text', host_read_text):
                self.test_documented_local_links_exist()

    def test_document_links_skip_dependencies_but_check_owned_documents(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            dependency = root / 'node_modules' / 'pdf-lib'
            dependency.mkdir(parents=True)
            (dependency / 'README.md').write_text('[Missing](upstream-only.md)', encoding='utf-8')
            owned = root / 'README.md'
            owned.write_text('# Owned', encoding='utf-8')
            with patch(__name__ + '.ROOT', root):
                result = unittest.TestResult()
                RepositoryTests('test_documented_local_links_exist').run(result)
                self.assertTrue(result.wasSuccessful(), result.failures + result.errors)
                owned.write_text('[Missing](missing-owned.md)', encoding='utf-8')
                result = unittest.TestResult()
                RepositoryTests('test_documented_local_links_exist').run(result)
                self.assertEqual(len(result.failures), 1)
                self.assertEqual(result.errors, [])

    def test_check_commands_cover_all_node_suites_with_resource_bounds(self):
        commands = [json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']['test']]
        commands.extend(line.strip() for line in (ROOT / 'Makefile').read_text(encoding='utf-8').splitlines()
                        if line.startswith('\tnode '))
        self.assertEqual(len(commands), 2)
        expected = set(ROOT.glob('tests/*/*.test.ts')) | set(ROOT.glob('browser-extension/connection-probe/tests/*.test.ts'))
        self.assertTrue(expected)
        for command in commands:
            with self.subTest(command=command):
                tokens = shlex.split(command)
                self.assertIn('--max-old-space-size=256', tokens)
                self.assertIn('--test-concurrency=1', tokens)
                patterns = [token for token in tokens if token.startswith('build/') and token.endswith('.test.js')]
                covered = {path for pattern in patterns for path in ROOT.glob(pattern.removeprefix('build/').removesuffix('.js') + '.ts')}
                self.assertEqual(covered, expected)

    def test_module_ownership_directories_exist(self):
        for directory in (
            "contracts", "core", "platforms/windows", "platforms/macos",
            "browser-extension", "tests/fixtures",
        ):
            with self.subTest(directory=directory):
                self.assertTrue((ROOT / directory).is_dir())


if __name__ == "__main__":
    unittest.main()
