#!/usr/bin/env python3
"""A T3 Code fixture: `serve` runs a loopback server that records itself under the base directory, and
`auth pairing create --json` issues single-use pairing links the server accepts once."""
import argparse
import datetime
import http.server
import json
import os
import secrets
import signal
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
commands = parser.add_subparsers(dest='command', required=True)
serve = commands.add_parser('serve')
serve.add_argument('--host', required=True)
serve.add_argument('--port', type=int, required=True)
serve.add_argument('--base-dir', required=True)
serve.add_argument('cwd')
auth = commands.add_parser('auth')
auth.add_argument('scope', choices=['pairing'])
auth.add_argument('action', choices=['create'])
auth.add_argument('--base-dir', required=True)
auth.add_argument('--json', action='store_true', required=True)
auth.add_argument('--base-url', required=True)
auth.add_argument('--label', required=True)
args = parser.parse_args()
state = Path(args.base_dir) / 'userdata'
state.mkdir(parents=True, exist_ok=True)
grants = state / 'pairings.json'

def read(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default

if args.command == 'auth':
    token = secrets.token_urlsafe(16)
    grants.write_text(json.dumps(read(grants, []) + [token]))
    print('timestamp=2026-01-01T00:00:00Z level=INFO message="Removed expired attachment uploads."')
    print(json.dumps({'id': secrets.token_hex(4), 'credential': token, 'label': args.label, 'scopes': ['client'],
                      'expiresAt': '2026-01-01T00:05:00.000Z', 'pairUrl': args.base_url.rstrip('/') + '/pair#token=' + token}, indent=2))
    sys.exit(0)

assert args.host == '127.0.0.1' and 0 < args.port < 65536 and os.environ.get('T3CODE_NO_BROWSER') == '1'
with (state / 'serve.log').open('a') as log:
    log.write(json.dumps({'pid': os.getpid(), 'port': args.port, 'cwd': args.cwd, 'directory': os.getcwd()}) + '\n')
runtime = state / 'server-runtime.json'
sessions = set()
PAGE = '''<!doctype html><title>T3 fixture</title><body><p id="state">{state}</p></body>'''
PAIR = '''<!doctype html><title>Pair</title><body><p id="state">pairing</p><script>
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', '/pair');
fetch('/api/auth/browser-session', {method: 'POST', body: JSON.stringify({credential: token})}).then(response => {
  if (!response.ok) { document.querySelector('#state').textContent = 'Invalid pairing token'; return; }
  history.replaceState(null, '', '/'); location.reload();
});
</script></body>'''

class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, status, body, kind='text/html', headers=()):
        data = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def paired(self):
        cookies = dict(part.strip().split('=', 1) for part in self.headers.get('Cookie', '').split(';') if '=' in part)
        return cookies.get('t3_session_{}'.format(args.port)) in sessions

    def do_GET(self):
        if self.path == '/.well-known/t3/environment':
            self.reply(200, json.dumps({'environmentId': 'fixture', 'label': 'fixture'}), 'application/json')
        elif self.path.startswith('/pair'):
            self.reply(200, PAIR)
        else:
            self.reply(200, PAGE.format(state='paired' if self.paired() else 'unpaired'))

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/api/auth/browser-session':
            tokens = read(grants, [])
            if body.get('credential') not in tokens:
                self.reply(401, '{"error":"invalid_credential"}', 'application/json')
                return
            tokens.remove(body['credential'])
            grants.write_text(json.dumps(tokens))
            session = secrets.token_hex(16)
            sessions.add(session)
            self.reply(200, '{}', 'application/json', [('Set-Cookie', 't3_session_{}={}; HttpOnly; Path=/; SameSite=Lax'.format(args.port, session))])
        else:
            self.reply(403, '{}', 'application/json')

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
def stop(*_):
    # T3 Code keeps its record while it shuts down.
    time.sleep(.5)
    try:
        runtime.unlink()
    except OSError:
        pass
    os._exit(0)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
runtime.write_text(json.dumps({'version': 1, 'pid': os.getpid(), 'host': args.host, 'port': args.port, 'origin': 'http://127.0.0.1:{}'.format(args.port),
                               'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}) + '\n')
print('T3 Code server is ready.\nPairing URL: http://localhost:{}/pair#token=startup'.format(args.port), flush=True)
server.serve_forever()
