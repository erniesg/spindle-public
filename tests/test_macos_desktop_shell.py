"""Spindle.app shell source/plist invariants, STRUCTURAL ONLY.

These checks read platforms/macos/DesktopApp.swift and Spindle.Info.plist as text on
Linux. They are NOT a Swift compile, do not produce or inspect a Mach-O, and prove no
window, WKWebView, Node lifecycle, packaging or installed Mac behaviour.
"""
import plistlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SWIFT = (ROOT / 'platforms/macos/DesktopApp.swift').read_text(encoding='utf-8')
PLIST = plistlib.loads((ROOT / 'platforms/macos/Spindle.Info.plist').read_bytes())
DOC = (ROOT / 'docs/MAC_DESKTOP_SHELL.md').read_text(encoding='utf-8')
CODE = '\n'.join(line.split('//')[0] for line in SWIFT.splitlines())


class InfoPlistTests(unittest.TestCase):
    def test_stable_identity_and_no_extra_permissions(self):
        self.assertEqual(PLIST['CFBundleIdentifier'], 'ai.berlayar.spindle')
        self.assertEqual(PLIST['CFBundleExecutable'], 'Spindle')
        self.assertEqual((PLIST['CFBundleName'], PLIST['CFBundleDisplayName']), ('Spindle', 'Spindle'))
        self.assertEqual(PLIST['CFBundlePackageType'], 'APPL')
        self.assertEqual(PLIST['LSMinimumSystemVersion'], '15.0')
        self.assertEqual(PLIST['NSAppTransportSecurity'], {'NSAllowsLocalNetworking': True})
        self.assertFalse([k for k in PLIST if re.search(r'UsageDescription|Camera|Microphone|LSUIElement|LSBackgroundOnly|URLTypes', k)])


class ShellSourceTests(unittest.TestCase):
    def test_only_appkit_webkit_foundation(self):
        self.assertEqual(sorted(re.findall(r'^import (\w+)', SWIFT, re.M)), ['AppKit', 'Foundation', 'WebKit'])

    def test_spawns_only_bundled_node_with_desktop_shell_flag(self):
        self.assertIn('Bundle.main.resourceURL', CODE)
        self.assertIn('"runtime/node"', CODE)
        self.assertIn('"build/core/preview/app.js"', CODE)
        self.assertIn('process.arguments = [paths.app.path, "--desktop-shell"]', CODE)
        self.assertEqual(CODE.count('Process()'), 1)
        self.assertNotRegex(CODE, r'/usr/bin/(env|open)|launchPath|"/bin/(ba)?sh"|Google Chrome')

    def test_ready_protocol_needs_nonce_echo_and_loopback_http(self):
        self.assertIn('"spindle.desktop-ready/v1"', CODE)
        self.assertIn('"SPINDLE_DESKTOP_NONCE": nonce', CODE)
        self.assertIn('Set(object.keys) == ["schema", "nonce", "url"]', CODE)
        self.assertIn('object["nonce"] as? String == nonce', CODE)
        self.assertIn('parts.scheme == "http", parts.host == "127.0.0.1"', CODE)

    def test_environment_is_allowlisted_not_inherited(self):
        self.assertIn('process.environment = childEnvironment(nonce: nonce)', CODE)
        self.assertNotIn('SPINDLE_NEBIUS_CONFIG', CODE)
        self.assertNotRegex(CODE, r'environment\s*=\s*ProcessInfo')

    def test_no_bridge_logging_or_foreign_process_control(self):
        self.assertNotRegex(CODE, r'addScriptMessageHandler|evaluateJavaScript|WKUserScript|NSLog|print\(|os_log')
        self.assertNotRegex(CODE, r'killall|pkill|runningApplications|NSRunningApplication')
        self.assertEqual(re.findall(r'\bkill\((\w+)', CODE), ['pid'])
        self.assertIn('guard let pid = child?.processIdentifier', CODE)
        self.assertNotRegex(CODE, r'xattr|spctl|codesign|SMAppService|LaunchAgents|tccutil|ScreenCaptureKit|CGRequest')

    def test_quit_waits_for_owned_service(self):
        self.assertIn('return .terminateLater', CODE)
        self.assertIn('process.terminate()', CODE)
        self.assertIn('NSApp.reply(toApplicationShouldTerminate: true)', CODE)
        self.assertIn('guard child == nil else { return }', CODE)

    def test_owned_blob_preview_and_user_chosen_download_destination(self):
        # Source shape only. Actual PDF navigation/Save panel still needs a Mac.
        self.assertIn('WKDownloadDelegate', CODE)
        self.assertIn('url.scheme == "blob"', CODE)
        self.assertIn('origin?.owns(inner) == true || ownsWorkspace(inner)', CODE)
        self.assertIn('action.shouldPerformDownload ? .download : .allow', CODE)
        self.assertIn('let panel = NSSavePanel()', CODE)
        self.assertIn('result == .OK ? panel.url : nil', CODE)

    def test_workspace_failure_is_nonfatal_and_retry_preserves_capture_service(self):
        self.assertIn('case starting, ready, workspaceUnavailable, failed, stopping', CODE)
        self.assertIn('Workspace unavailable; use Capture & Timer; retry connection.', SWIFT)
        self.assertIn('Capture status is unchanged; check Capture & Timer.', SWIFT)
        self.assertNotIn('Workspace unavailable.\\\\nNothing is recording.', SWIFT)
        self.assertIn('navigationResponse.isForMainFrame', CODE)
        self.assertIn('let isWorkspaceEntry = response.url?.path == "/portal" || response.url?.path == "/portal/"', CODE)
        self.assertIn('isWorkspaceEntry && response.mimeType?.lowercased() != "text/html"', CODE)
        self.assertNotIn('didStartProvisionalNavigation', CODE)
        self.assertIn('response.statusCode >= 400', CODE)
        self.assertIn('response.mimeType?.lowercased() != "text/html"', CODE)
        self.assertIn('navigation === activeNavigation', CODE)
        self.assertIn('error.code != NSURLErrorCancelled', CODE)
        self.assertIn('if state == .workspaceUnavailable { return showWorkspace() }', CODE)
        self.assertIn('state == .ready || state == .workspaceUnavailable', CODE)

    def test_workspace_links_use_tracked_load_and_menu_generation_fence(self):
        # Structural lifecycle regression, not an executable WebKit lifecycle test:
        # /portal -> user /connections or /mail -> network failure must use tracked load.
        # A queued user link must not replace Capture after a later menu selection.
        self.assertIn('private var navigationGeneration = 0', CODE)
        policy = CODE.split('decidePolicyFor action: WKNavigationAction,', 1)[1].split('private func workspaceUnavailable', 1)[0]
        self.assertIn('action.navigationType == .linkActivated', policy)
        self.assertIn('action.targetFrame?.isMainFrame == true', policy)
        self.assertIn('!action.shouldPerformDownload, ownsWorkspace(action.request.url)', policy)
        self.assertIn('navigationGeneration += 1', policy)
        self.assertIn('let generation = navigationGeneration', policy)
        self.assertIn('decisionHandler(.cancel)', policy)
        self.assertIn('self.navigationGeneration == generation', policy)
        self.assertIn('self.wantsWorkspace, self.state == .ready', policy)
        self.assertIn('self.activeNavigation = webView.load(action.request)', policy)
        capture = CODE.split('@objc private func showCapture()', 1)[1].split('@objc private func showWorkspace()', 1)[0]
        workspace = CODE.split('@objc private func showWorkspace()', 1)[1].split('@objc private func retry()', 1)[0]
        for menu in (capture, workspace):
            self.assertIn('navigationGeneration += 1', menu)
            self.assertLess(menu.index('navigationGeneration += 1'), menu.index('webView.stopLoading()'))
        failure = CODE.split('private func workspaceLoadFailed', 1)[1].split('func webView(', 1)[0]
        self.assertIn('navigation === activeNavigation', failure)
        self.assertIn('error.code != NSURLErrorCancelled', failure)

    def test_content_process_reload_tracks_failure_and_invalidates_queued_links(self):
        reload = CODE.split('func webViewWebContentProcessDidTerminate', 1)[1].split('\\n}', 1)[0]
        self.assertIn('guard state == .ready, child?.isRunning == true else { return }', reload)
        self.assertIn('navigationGeneration += 1', reload)
        self.assertIn('activeNavigation = webView.reload()', reload)
        self.assertLess(reload.index('navigationGeneration += 1'), reload.index('activeNavigation = webView.reload()'))

    def test_navigation_limited_to_own_origin(self):
        self.assertIn('decisionHandler(.cancel)', CODE)
        self.assertIn('url.scheme == "https"', CODE)
        self.assertIn('return nil', CODE)
        self.assertIn('javaScriptCanOpenWindowsAutomatically = false', CODE)


class DocTests(unittest.TestCase):
    def test_doc_compile_command_matches_imports_and_labels_proof(self):
        command = next(line for line in DOC.splitlines() if line.startswith('xcrun swiftc'))
        for framework in ('AppKit', 'WebKit', 'Foundation'):
            self.assertIn(f'-framework {framework}', command)
        self.assertIn('-target arm64-apple-macos15.0', command)
        self.assertIn('-parse-as-library', command)
        self.assertIn('not a Swift compile', DOC)


if __name__ == '__main__':
    unittest.main()
