"""Compiled runtime payload/import closure, NOT native OS/package acceptance."""
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import package_preview


class PomodoroPackageTests(unittest.TestCase):
    @unittest.skipUnless((ROOT / 'build/core/preview/timer-only.js').exists(), 'npm run build first')
    def test_actual_preview_payload_includes_timer_native_and_extension_import_closure(self):
        payload = {str(p.relative_to(ROOT)): p.read_bytes() for p in package_preview.runtime_paths() if p.is_file()}
        for name in ['build/core/preview/app.js', 'build/core/preview/timer-only.js',
                     'build/core/preview/pomodoro-control.js', 'build/core/account/client.js',
                     'build/core/memory/user-protocol.js', 'build/core/pomodoro/desktop-ui.js',
                     'build/browser-extension/preview/pomodoro/pomodoro.html',
                     'build/browser-extension/preview/pomodoro/shared/ui.js']:
            self.assertIn(name, payload)
        for name, data in payload.items():
            if not name.endswith('.js'):
                continue
            for relative in re.findall(r'''\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]''', data.decode()):
                target = (ROOT / name).parent.joinpath(relative).resolve()
                self.assertIn(str(target.relative_to(ROOT)), payload, f'{name} -> {relative}')
        (ROOT / '.local').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='pm-payload-', dir=ROOT / '.local') as temporary:
            directory = Path(temporary)
            archive = directory / 'payload.zip'
            payload['package.json'] = b'{"private":true,"type":"module"}\n'
            # Same launcher bytes selected by package_preview.main; payload ZIP
            # check only, not a native build or cmd.exe execution on Linux.
            launcher = (ROOT / 'platforms/windows/start-preview.cmd').read_bytes()
            payload['Start Spindle Preview.cmd'] = launcher
            with zipfile.ZipFile(archive, 'w') as bundle:
                for name, data in payload.items():
                    bundle.writestr(name, data)
            extracted = directory / 'extracted'
            with zipfile.ZipFile(archive) as bundle:
                self.assertIsNone(bundle.testzip())
                bundle.extractall(extracted)
                for name, data in payload.items():
                    self.assertEqual((extracted / name).read_bytes(), data)
            self.assertIn(b'"%ROOT%build\\core\\preview\\app.js" %*',
                          (extracted / 'Start Spindle Preview.cmd').read_bytes())
            # Import actual packaged entrypoints without invoking their CLI guards;
            # no helper spawn, account fixture, registration or capture is performed.
            entries = [str(extracted / 'build/core/preview/app.js'), str(extracted / 'build/core/preview/browser-host.js')]
            # browser-host is a stdio CLI, so check syntax rather than run its stdin loop.
            subprocess.run(['node', '--check', entries[1]], check=True, capture_output=True)
            subprocess.run(['node', '--input-type=module', '-e',
                            "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[2]).href)", 'import-probe', entries[0]],
                           check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
