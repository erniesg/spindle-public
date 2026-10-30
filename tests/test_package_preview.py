"""Generated archive payload boundary; not native execution acceptance."""
import hashlib
import json
import hashlib
import os
import posixpath
import shutil
from unittest.mock import patch
import re
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import package_preview
from package_preview import package_files, clear_generated_build, runtime_dependency_closure, RUNTIME_PACKAGES


class PreviewPackageTests(unittest.TestCase):
    def test_runtime_closure_includes_cycles_and_literal_dynamic_imports_once(self):
        scratch=Path(__file__).resolve().parents[1]/'.local'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            root=Path(temporary);build=root/'build';(build/'nested').mkdir(parents=True)
            (build/'main.js').write_text("import './nested/feature.js'; import('./lazy.js');")
            (build/'nested/feature.js').write_text("export {value} from '../main.js';")
            (build/'lazy.js').write_text('export const loaded=true;')
            (root/'not-runtime.txt').write_text('invented host-only data')
            self.assertEqual(set(runtime_dependency_closure([build/'main.js'],root)),
                             {build/'main.js',build/'nested/feature.js',build/'lazy.js'})

    def test_runtime_closure_rejects_missing_or_outside_build_imports(self):
        scratch=Path(__file__).resolve().parents[1]/'.local'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as temporary:
            root=Path(temporary);build=root/'build';build.mkdir()
            entry=build/'main.js';entry.write_text("import './missing.js';")
            with self.assertRaisesRegex(FileNotFoundError,'MISSING_RUNTIME_IMPORT'):
                runtime_dependency_closure([entry],root)
            (root/'outside.js').write_text('export const privateValue="invented";')
            entry.write_text("import '../outside.js';")
            with self.assertRaisesRegex(ValueError,'RUNTIME_IMPORT_OUTSIDE_BUILD'):
                runtime_dependency_closure([entry],root)

    def test_runtime_closure_rejects_unknown_bare_imports_and_preserves_builtins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);build=root/'build';build.mkdir()
            entry=build/'main.js'
            for source in ["import 'unreviewed';", "export {x} from 'unreviewed';", "import('unreviewed');"]:
                entry.write_text(source)
                with self.assertRaisesRegex(ValueError,'UNSUPPORTED_RUNTIME_IMPORT'):
                    runtime_dependency_closure([entry],root)
            entry.write_text("import {readFile} from 'node:fs/promises';")
            self.assertEqual(runtime_dependency_closure([entry],root),[entry])

    def test_runtime_package_is_conditional_and_rejects_lock_drift(self):
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            isolated=Path(temporary);build=isolated/'build';build.mkdir()
            entry=build/'main.js';entry.write_text("export const independent=true;")
            # An unrelated/no-dependency graph needs no node_modules or lockfile.
            self.assertEqual(runtime_dependency_closure([entry],isolated),[entry])
        # Changing the reviewed pin cannot silently package different installed bytes.
        with patch.dict(RUNTIME_PACKAGES,{'jose':dict(RUNTIME_PACKAGES['jose'],version='0.0.0')}):
            with self.assertRaisesRegex(ValueError,'RUNTIME_PACKAGE_LOCK_MISMATCH'):
                runtime_dependency_closure([root/'build/core/account/workos-provider.js'],root)

    def test_runtime_package_rejects_installed_byte_changes_with_unchanged_lock(self):
        repository=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);build=root/'build';build.mkdir()
            entry=build/'main.js';entry.write_text("import 'jose';")
            shutil.copyfile(repository/'package-lock.json',root/'package-lock.json')
            shutil.copytree(repository/'node_modules/jose',root/'node_modules/jose')
            self.assertTrue(runtime_dependency_closure([entry],root))
            for relative in ['dist/webapi/index.js','package.json','LICENSE.md']:
                target=root/'node_modules/jose'/relative;original=target.read_bytes()
                with self.subTest(modified=relative):
                    target.write_bytes(original+b'\n ')
                    try:
                        with self.assertRaisesRegex(ValueError,'RUNTIME_PACKAGE_FILE_MISMATCH'):
                            runtime_dependency_closure([entry],root)
                    finally:target.write_bytes(original)
                with self.subTest(missing=relative):
                    target.unlink()
                    try:
                        with self.assertRaisesRegex(ValueError,'RUNTIME_PACKAGE_FILE_MISMATCH'):
                            runtime_dependency_closure([entry],root)
                    finally:target.write_bytes(original)

    def test_receipt_uses_verified_copy_when_installed_source_changes_after_copy(self):
        repository=Path(__file__).resolve().parents[1]
        for action in ['modify','delete']:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);build=root/'build';build.mkdir()
                entry=build/'main.js';entry.write_text("import 'jose';")
                shutil.copyfile(repository/'package-lock.json',root/'package-lock.json')
                shutil.copytree(repository/'node_modules/jose',root/'node_modules/jose')
                paths=[entry]
                source=root/'node_modules/jose/dist/webapi/jwt/verify.js'
                verify=package_preview.verify_runtime_package_file
                changed=[]
                def after_verified_copy(path,directory,anchor,data=None):
                    result=verify(path,directory,anchor,data)
                    if path==source:
                        if action=='delete':source.unlink()
                        else:source.write_bytes(b'// invented post-copy change')
                        changed.append(True)
                    return result
                with patch.object(package_preview,'ROOT',root), patch.object(package_preview,'runtime_entry_paths',return_value=paths), patch.object(package_preview,'verify_runtime_package_file',side_effect=after_verified_copy):
                    files=package_files()
                self.assertEqual(changed,[True])
                receipt=json.loads(files['runtime/dependencies.json'])['dependencies']['jose']['files']
                self.assertEqual(receipt,{name:hashlib.sha256(data).hexdigest()
                                         for name,data in files.items() if name.startswith('node_modules/jose/')})

    def test_dependency_graph_uses_verified_bytes_without_reopening_source(self):
        repository=Path(__file__).resolve().parents[1]
        entry=repository/'node_modules/jose/dist/webapi/index.js'
        verify=package_preview.verify_runtime_package_file
        read_text=Path.read_text
        verified=[];transient_reads=[]
        def verified_entry(path,directory,anchor,data=None):
            result=verify(path,directory,anchor,data)
            if path==entry:verified.append(True)
            return result
        def transient_second_read(path,*args,**kwargs):
            if path==entry and verified:
                transient_reads.append(True)
                return 'export const transient=true;'
            return read_text(path,*args,**kwargs)
        with patch.object(package_preview,'verify_runtime_package_file',side_effect=verified_entry), patch.object(Path,'read_text',transient_second_read):
            files=package_files()
        self.assertTrue(verified)
        self.assertEqual(transient_reads,[])
        self.assertIn('node_modules/jose/dist/webapi/jwt/verify.js',files)
        self.assertEqual(files['node_modules/jose/dist/webapi/index.js'],entry.read_bytes())
        receipt=json.loads(files['runtime/dependencies.json'])['dependencies']['jose']['files']
        self.assertEqual(receipt,{name:hashlib.sha256(data).hexdigest()
                                 for name,data in files.items() if name.startswith('node_modules/jose/')})

    def test_windows_launcher_forwards_arguments_without_requoting(self):
        root = Path(__file__).resolve().parents[1]
        dispatch = next(line for line in (root/'platforms/windows/start-preview.cmd').read_text().splitlines()
                        if line.startswith('"%ROOT%runtime\\node.exe"'))
        # Linux source guard only: cmd.exe parsing is exercised below on Windows.
        self.assertEqual(dispatch, '"%ROOT%runtime\\node.exe" "%ROOT%build\\core\\preview\\app.js" %*')

    @unittest.skipUnless(os.name == 'nt' and shutil.which('node'), 'requires Windows cmd.exe and Node')
    def test_windows_launcher_preserves_default_and_quoted_argv(self):
        root = Path(__file__).resolve().parents[1]
        scratch = root/'.local/cross-device-sync'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch, prefix='launcher with spaces ') as directory:
            package = Path(directory)
            (package/'runtime').mkdir()
            (package/'build/core/preview').mkdir(parents=True)
            shutil.copyfile(shutil.which('node'), package/'runtime/node.exe')
            (package/'build/core/preview/app.js').write_text('console.log(JSON.stringify(process.argv.slice(2)));')
            launcher = package/'Start Spindle Preview.cmd'
            shutil.copyfile(root/'platforms/windows/start-preview.cmd', launcher)
            for args in [[], ['--no-open'], ['--timer-only', '--control-directory', str(package/'control & spaces'), '--no-open']]:
                command = '"'+subprocess.list2cmdline([str(launcher), *args])+'"'
                result = subprocess.run(['cmd.exe', '/d', '/s', '/c', command],
                                        check=True, capture_output=True, text=True)
                self.assertEqual(json.loads(result.stdout), args)

    def test_macos_launcher_forwards_public_capture_free_cli_arguments(self):
        root = Path(__file__).resolve().parents[1]
        dispatch = next(line for line in (root/'platforms/macos/start-preview.command').read_text().splitlines()
                        if line.startswith('exec "$node"'))
        # Execute the real final dispatch with an argv recorder, not a mock Mac
        # capture helper. Platform/native acceptance remains a separate test.
        with tempfile.TemporaryDirectory() as directory:
            node = Path(directory)/'node recorder'
            node.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
            node.chmod(0o700)
            args = ['--timer-only', '--control-directory', directory+'/control with spaces', '--no-open']
            result = subprocess.run(['bash', '-c', 'node="$1"; root="$2"; shift 2; '+dispatch,
                                     'launcher-test', str(node), directory, *args],
                                    check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout.splitlines(), [directory+'/build/core/preview/app.js', *args])

    def test_installed_blocking_graph_resolves_without_host_credentials_modules(self):
        root = Path(__file__).resolve().parents[1] / 'build/browser-extension/preview'
        self.assertTrue((root/'blocking/purpose-client.js').is_file())
        for name in ['control.js', 'classifier.js', 'file-budget.js', 'purpose-config.js']:
            self.assertFalse((root/'blocking/core'/name).exists(), f'host-only module shipped to extension: {name}')
        edges = 0
        for path in root.rglob('*.js'):
            for dependency in re.findall(r'''(?m)^(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?[\"']([^\"']+)[\"']''', path.read_text()):
                self.assertFalse(dependency.startswith('node:'), f'Node-only dependency in browser graph: {path}')
                if not dependency.startswith('.'):
                    continue
                target = (path.parent/dependency).resolve()
                self.assertTrue(target.is_relative_to(root.resolve()) and target.is_file(), f'installed browser import missing/escaped: {path} -> {dependency}')
                edges += 1
        self.assertGreater(edges, 0)

    def test_clean_packaging_removes_stale_generated_files_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root/'build/core/preview').mkdir(parents=True)
            (root/'build/core/preview/removed-source.js').write_text('invented stale output')
            (root/'keep.txt').write_text('invented retained source')
            clear_generated_build(root)
            self.assertFalse((root/'build').exists())
            self.assertEqual((root/'keep.txt').read_text(), 'invented retained source')

    def test_generated_runtime_imports_and_api_handoff_are_in_archive_payload(self):
        files = package_files()
        for name, content in files.items():
            if not name.endswith('.js'):
                continue
            for dependency in re.findall(r'(?:from\s*|import\s*)[\'\"](\.[^\'\"]+)[\'\"]', content.decode('utf-8')):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), dependency))
                self.assertTrue(target in files, f'{name} imports missing archive member {target}')
        self.assertTrue('docs/TRACKING_API.md' in files, 'API handoff missing from archive')
        for required in ['docs/POMODORO.md', 'docs/SITE_BLOCKING.md', 'build/core/pomodoro/desktop-ui.js',
                         'build/core/pomodoro/client.js', 'build/core/preview/pomodoro-control.js',
                         'build/core/preview/browser-host.js',
                         'build/browser-extension/preview/pomodoro/page.js',
                         'build/tools/preview-host-stage.js']:
            self.assertIn(required, files, f'bundled timer/Native Messaging handoff missing: {required}')
        dependencies={name for name in files if name.startswith('node_modules/')}
        self.assertTrue(dependencies)
        self.assertTrue(all(name.startswith('node_modules/jose/') for name in dependencies))
        self.assertIn('node_modules/jose/LICENSE.md',files)
        self.assertIn('node_modules/jose/package.json',files)
        receipt=json.loads(files['runtime/dependencies.json'])['dependencies']
        self.assertEqual(set(receipt),{'jose'})
        self.assertEqual(receipt['jose']['version'],'6.1.3')
        import hashlib
        self.assertEqual(receipt['jose']['files'],{name:hashlib.sha256(files[name]).hexdigest() for name in dependencies})
        self.assertFalse(any(part in {'.local', '.git', 'tests'} for name in files for part in Path(name).parts))

    def test_invented_pdf_viewer_fixture_is_packaged_without_build_dependency(self):
        files = package_files()
        pdf = files['build/core/preview/sample.pdf']
        self.assertTrue(pdf.startswith(b'%PDF-'))
        self.assertTrue(pdf.rstrip().endswith(b'%%EOF'))
        self.assertNotIn('build/tools/generate-preview-pdf.js', files)
        self.assertFalse(any(name.startswith('node_modules/pdf-lib/') for name in files))
        page = files['build/core/preview/index.html']
        self.assertIn(b'href="/sample/pdf"', page)
        self.assertIn(b'download="Spindle-Invented-Viewer-Sample.pdf"', page)
        self.assertIn(b'not a prepared application or AI result', page)

    def test_focus_dial_renderer_shared_ui_and_fonts_are_in_archive_payload(self):
        files = package_files()
        base = 'build/core/'
        for required in ['pomodoro/focus-dial.js', 'pomodoro/focus-dial-style.js', 'ui/dom.js', 'ui/styles.js', 'ui/theme.js',
                         'account/portal/pomodoro.js', 'account/portal/assets.js', 'account/portal/page.js', 'account/portal/build.json']:
            self.assertIn(base + required, files, f'focus dial / shared UI member missing from archive: {required}')
        # The served modules import the shared primitives and the renderer, so closure alone proves them in the payload.
        self.assertIn(b"../../pomodoro/focus-dial.js", files[base + 'account/portal/pomodoro.js'])
        self.assertIn(b"../../ui/dom.js", files[base + 'account/portal/pomodoro.js'])
        self.assertIn(b"../../ui/styles.js", files[base + 'account/portal/page.js'])
        approved = {'instrument.woff2': '5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31',
                    'dm-sans-normal.woff2': '9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543',
                    'dm-sans-OFL.txt': '9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1',
                    'Instrument-Serif-OFL.txt': 'b6b2292aa580937fb63796878d65a027a27f8c3db2d97601d0c34d9031f4ca17'}
        record = json.loads(files[base + 'account/portal/build.json'])
        packaged = {Path(n).name for n in files if n.startswith(base + 'account/portal/') and Path(n).suffix in {'.woff2', '.txt'}}
        if record['fonts']['status'] == 'staged':
            self.assertEqual(packaged, set(approved))
            for name, digest in approved.items():
                self.assertEqual(hashlib.sha256(files[base + 'account/portal/' + name]).hexdigest(), digest, name)
            self.assertEqual({f['file']: f['sha256'] for f in record['fonts']['files']}, approved)
        else:
            # No staged input: the build says so and ships no font bytes rather than claiming parity.
            self.assertEqual(record['fonts'], {'status': 'absent', 'files': []})
            self.assertEqual(packaged, set())
        # The displayed UI hash is the one the build computed over the shared UI, renderer and fonts.
        digest = hashlib.sha256()
        for name in ['account/portal/app.js', 'account/portal/tracking.js', 'account/portal/pomodoro.js', 'account/portal/blocking.js',
                     'account/portal/application.js', 'account/portal/page.js', 'account/client.js', 'pomodoro/client.js', 'pomodoro/protocol.js',
                     'pomodoro/focus-dial.js', 'pomodoro/focus-dial-style.js', 'account/portal/assets.js', 'ui/theme.js', 'ui/styles.js', 'ui/dom.js', 'ui/life-dial.js', 'ui/life-dial-geometry.js', 'ui/life-dial-style.js']:
            digest.update((name + '\0').encode())
            digest.update(files[base + name])
        for font in record['fonts']['files']:
            digest.update((font['file'] + '\0' + font['sha256'] + '\0').encode())
        self.assertEqual(digest.hexdigest(), record['bundleSha256'])
        # Build input location is explicit and never a host path in packaged source.
        for name in [base + 'pomodoro/focus-dial.js', base + 'pomodoro/focus-dial-style.js', base + 'account/portal/pomodoro.js', base + 'account/portal/build.json']:
            self.assertNotIn(b'/home/', files[name], name)


if __name__ == '__main__':
    unittest.main()
