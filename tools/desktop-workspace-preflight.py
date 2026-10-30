#!/usr/bin/env python3
"""Read-only coordinator check. Output is a content-free JSON receipt, never server data."""
import http.client
import ipaddress
import json
import signal
import sys
from urllib.parse import urlsplit

MAX_RESPONSE = 262144
REQUEST_TIMEOUT = 3
TOTAL_TIMEOUT = 12
MODULE = '/portal/code/account/portal/app.js'


class Rejected(Exception):
    pass


def parse_origin(value):
    try:
        parts = urlsplit(value)
        host = parts.hostname
        address = ipaddress.ip_address(host)
        if (parts.scheme != 'http' or not address.is_loopback or parts.username is not None
                or parts.password is not None or parts.path or parts.query or parts.fragment
                or '?' in value or '#' in value or parts.port is None
                or not 1 <= parts.port <= 65535 or value != f'http://{"[" + host + "]" if address.version == 6 else host}:{parts.port}'):
            raise ValueError()
        return host, parts.port
    except (ValueError, TypeError):
        raise Rejected('INVALID_ORIGIN') from None


def probe(host, port, path, checks):
    connection = http.client.HTTPConnection(host, port, timeout=REQUEST_TIMEOUT)
    try:
        connection.request('GET', path, headers={'Accept': 'text/html' if path == '/portal' else 'text/javascript'})
        response = connection.getresponse()
        checks.append({'check': 'portal' if path == '/portal' else 'module', 'status': response.status})
        if 300 <= response.status < 400:
            raise Rejected('PORTAL_REDIRECT_DENIED')
        if response.status != 200:
            raise Rejected('PORTAL_HTTP_ERROR' if path == '/portal' else 'PORTAL_MODULE_HTTP_ERROR')
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise Rejected('RESPONSE_TOO_LARGE')
        return response.getheader('Content-Type', '').split(';')[0].strip().lower(), body
    finally:
        connection.close()


def timeout(_signum, _frame):
    raise TimeoutError()


def main():
    checks = []
    code = 'INVALID_ORIGIN'
    try:
        if len(sys.argv) != 2:
            raise Rejected(code)
        host, port = parse_origin(sys.argv[1])
        # A wall-clock cap also bounds slow-drip response bodies and headers.
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, TOTAL_TIMEOUT)
        kind, body = probe(host, port, '/portal', checks)
        if (kind != 'text/html' or b'id="portal-workspace"' not in body
                or b'<script type="module" src="' + MODULE.encode() + b'"></script>' not in body):
            raise Rejected('PORTAL_CONTENT_INVALID')
        kind, body = probe(host, port, MODULE, checks)
        if kind not in ('text/javascript', 'application/javascript') or b'AccountClient' not in body or b'location.origin' not in body:
            raise Rejected('PORTAL_MODULE_INVALID')
        code = 'WORKSPACE_READY'
    except Rejected as error:
        code = str(error)
    except (OSError, http.client.HTTPException, TimeoutError):
        code = 'WORKSPACE_UNREACHABLE'
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    ok = code == 'WORKSPACE_READY'
    print(json.dumps({'schema': 'spindle.workspace-preflight/v1', 'ok': ok, 'code': code, 'checks': checks}, sort_keys=True))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
