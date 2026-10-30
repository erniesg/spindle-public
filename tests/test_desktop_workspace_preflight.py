"""Local fixture HTTP checks; no installed or live-runtime acceptance."""
import json
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / 'tools/desktop-workspace-preflight.py'
PORTAL = b'<html><main id="portal-workspace"></main><script type="module" src="/portal/code/account/portal/app.js"></script></html>'
MODULE = b"import {AccountClient} from '../client.js'; const client=new AccountClient(location.origin,fetch,true);"


class PreflightTests(unittest.TestCase):
    def run_probe(self, routes=None, origin=None):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                status, kind, body = routes.get(self.path, (404, 'text/plain', b'private sentinel'))
                if kind == 'slow':
                    time.sleep(3.3)
                    return
                self.send_response(status)
                self.send_header('Content-Type', kind)
                if status == 302:
                    self.send_header('Location', '/must-not-follow')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = None
        if routes is not None:
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f'http://127.0.0.1:{server.server_port}'
        try:
            result = subprocess.run([sys.executable, str(TOOL), origin], capture_output=True, text=True, timeout=20)
            self.assertNotIn('private sentinel', result.stdout + result.stderr)
            self.assertEqual(result.stderr, '')
            return result.returncode, json.loads(result.stdout), requests
        finally:
            if server:
                server.shutdown()
                server.server_close()

    def good_routes(self):
        return {'/portal': (200, 'text/html', PORTAL),
                '/portal/code/account/portal/app.js': (200, 'text/javascript', MODULE)}

    def test_current_portal_and_module_succeed_without_build_binding(self):
        code, receipt, requests = self.run_probe(self.good_routes())
        self.assertEqual((code, receipt['ok'], receipt['code']), (0, True, 'WORKSPACE_READY'))
        self.assertEqual(requests, ['/portal', '/portal/code/account/portal/app.js'])

    def test_old_origin_denied_is_clear_and_sanitized(self):
        code, receipt, _ = self.run_probe({'/portal': (403, 'application/json', b'{"error":"ORIGIN_DENIED","secret":"private sentinel"}')})
        self.assertEqual((code, receipt['code']), (1, 'PORTAL_HTTP_ERROR'))
        self.assertEqual(receipt['checks'][0]['status'], 403)

    def test_mismatched_200_asset_is_rejected(self):
        routes = self.good_routes()
        routes['/portal/code/account/portal/app.js'] = (200, 'text/html', b'private sentinel')
        code, receipt, _ = self.run_probe(routes)
        self.assertEqual((code, receipt['code']), (1, 'PORTAL_MODULE_INVALID'))

    def test_wrong_javascript_asset_is_rejected(self):
        routes = self.good_routes()
        routes['/portal/code/account/portal/app.js'] = (200, 'text/javascript', b'console.log("private sentinel")')
        code, receipt, _ = self.run_probe(routes)
        self.assertEqual((code, receipt['code']), (1, 'PORTAL_MODULE_INVALID'))

    def test_backend_response_timeout_is_sanitized(self):
        code, receipt, _ = self.run_probe({'/portal': (200, 'slow', b'')})
        self.assertEqual((code, receipt['code']), (1, 'WORKSPACE_UNREACHABLE'))

    def test_numeric_ipv6_loopback_is_accepted(self):
        code, receipt, _ = self.run_probe(origin='http://[::1]:1')
        self.assertEqual((code, receipt['code']), (1, 'WORKSPACE_UNREACHABLE'))

    def test_unrelated_html_is_not_a_portal(self):
        code, receipt, _ = self.run_probe({'/portal': (200, 'text/html', b'<html>private sentinel</html>')})
        self.assertEqual((code, receipt['code']), (1, 'PORTAL_CONTENT_INVALID'))

    def test_missing_backend(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), BaseHTTPRequestHandler)
        port = server.server_port
        server.server_close()
        code, receipt, _ = self.run_probe(origin=f'http://127.0.0.1:{port}')
        self.assertEqual((code, receipt['code']), (1, 'WORKSPACE_UNREACHABLE'))

    def test_redirect_is_not_followed(self):
        code, receipt, requests = self.run_probe({'/portal': (302, 'text/html', b'private sentinel')})
        self.assertEqual((code, receipt['code']), (1, 'PORTAL_REDIRECT_DENIED'))
        self.assertEqual(requests, ['/portal'])

    def test_oversized_response_is_rejected(self):
        code, receipt, _ = self.run_probe({'/portal': (200, 'text/html', b'x' * 262145)})
        self.assertEqual((code, receipt['code']), (1, 'RESPONSE_TOO_LARGE'))

    def test_explicit_numeric_loopback_origin_only(self):
        for origin in ['https://127.0.0.1:43166', 'http://localhost:43166', 'http://192.168.1.1:43166',
                       'http://user:private-sentinel@127.0.0.1:43166', 'http://127.0.0.1:43166/portal',
                       'http://127.0.0.1:43166?x=private-sentinel', 'http://127.0.0.1:43166#x',
                       'http://127.0.0.1', 'http://127.1:43166', 'http://127.0.0.1:43166/']:
            with self.subTest(origin=origin):
                code, receipt, _ = self.run_probe(origin=origin)
                self.assertEqual((code, receipt['code']), (1, 'INVALID_ORIGIN'))
                self.assertNotIn('private-sentinel', json.dumps(receipt))


if __name__ == '__main__':
    unittest.main()
