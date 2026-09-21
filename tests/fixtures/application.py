#!/usr/bin/env python3
"""A browser application fixture with a remote notice and an ephemeral listener."""
import argparse
import http.server
import os
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('command')
parser.add_argument('--host')
parser.add_argument('--port', type=int)
parser.add_argument('--cli-data-dir')
parser.add_argument('--server-data-dir')
parser.add_argument('--commit-id')
parser.add_argument('--log', choices=['trace'], required=True)
args = parser.parse_args()
assert args.host == '127.0.0.1' and args.port == 0
Path(args.server_data_dir).mkdir(parents=True, exist_ok=True)
Path(args.server_data_dir, 'fixture.pid').write_text(str(os.getpid()))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.server.requests < 9:
            self.server.requests += 1
            progress = '25/0' if self.server.requests == 1 else '50/100 (50%)' if self.server.requests < 4 else '100/100 (100%)'
            line = '[2026-01-01 00:00:00] trace Downloading server: ' + progress
            if self.server.requests >= 7:
                line = '[2026-01-01 00:00:00] info Starting server ' + 'a' * 40
            # A line may span reads, and unrelated diagnostics must not reach the UI.
            print('[2026-01-01 00:00:00] trace unrelated diagnostic', flush=True)
            print(line[:40], end='', flush=True)
            time.sleep(.05)
            print(line[40:], flush=True)
            self.send_response(202)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<html><title>Editor fixture</title><body>vscode workbench<input aria-label="Editor"><a href="http://127.0.0.1:1/" target="_blank">Preview</a></body></html>')
    def log_message(self, *args):
        pass
server = http.server.HTTPServer((args.host, args.port), Handler)
server.requests = 0
print('[2026-01-01 00:00:00] debug startup diagnostic', flush=True)
print('Fixture application terms https://example.com/terms', flush=True)
print('Web UI available at http://127.0.0.1:{}?tkn=fixture'.format(server.server_port), flush=True)
server.serve_forever()
