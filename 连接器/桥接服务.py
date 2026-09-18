"""Local-only authenticated Figma bridge. Python 3.10+, standard library only."""
import argparse
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

MAX_BODY = 32 * 1024 * 1024
MAX_JOBS = 128
TTL = 900

class Bridge(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, token):
        super().__init__(address, Handler)
        self.token = token
        self.lock = threading.RLock()
        self.jobs = {}
        self.clients = {}

    def prune(self):
        now = time.monotonic()
        for cid, item in list(self.jobs.items()):
            if now - item['updated'] > TTL:
                del self.jobs[cid]
        for cid, item in list(self.clients.items()):
            if now - item['seen'] > 60:
                del self.clients[cid]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, code, data=None):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8') if data is not None else b''
        self.send_response(code)
        # Bearer token required for all data endpoints; no cookie authentication.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        valid = hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token)
        if not valid:
            self.respond(401, {'error': 'unauthorized'})
        return valid

    def do_OPTIONS(self):
        self.respond(204)

    def do_GET(self):
        if not self.authorized():
            return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        s = self.server
        with s.lock:
            s.prune()
            if parsed.path == '/health':
                return self.respond(200, {'ok': True, 'version': '0.2.0'})
            if parsed.path == '/clients':
                return self.respond(200, {'clients': [{'id': k, 'pageId': v['pageId']} for k, v in s.clients.items()]})
            if parsed.path == '/poll':
                client = query.get('client', [''])[0]
                page = query.get('page', [''])[0]
                if not client or not page or len(client) > 200:
                    return self.respond(400, {'error': 'client and page required'})
                s.clients[client] = {'seen': time.monotonic(), 'pageId': page}
                for cid, item in s.jobs.items():
                    if item['state'] == 'queued' and item['target'] == client:
                        item.update(state='running', updated=time.monotonic())
                        return self.respond(200, {'id': cid, 'batch': item['batch']})
                return self.respond(204)
            if parsed.path.startswith('/commands/'):
                cid = parsed.path.rsplit('/', 1)[-1]
                item = s.jobs.get(cid)
                if not item:
                    return self.respond(404, {'error': 'unknown or expired command'})
                return self.respond(200, {'id': cid, 'state': item['state'], 'result': item.get('result')})
        self.respond(404, {'error': 'not found'})

    def do_POST(self):
        if not self.authorized():
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > MAX_BODY:
                return self.respond(413, {'error': 'body must be 1..32MiB'})
            self.connection.settimeout(30)
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('object required')
        except (ValueError, OSError):
            return self.respond(400, {'error': 'invalid JSON body'})
        s = self.server
        parsed = urlparse(self.path)
        with s.lock:
            s.prune()
            if parsed.path == '/result':
                if not isinstance(data.get('id'), str) or not isinstance(data.get('client'), str) or not isinstance(data.get('result'), dict):
                    return self.respond(400, {'error': 'id, client and result object required'})
                item = s.jobs.get(data.get('id'))
                if not item:
                    return self.respond(404, {'error': 'unknown or expired command'})
                if item['target'] != data.get('client'):
                    return self.respond(403, {'error': 'wrong client'})
                if item['state'] == 'done':
                    return self.respond(200, {'ok': True, 'duplicate': True})
                if item['state'] != 'running':
                    return self.respond(409, {'error': 'command is not running'})
                item.update(state='done', result=data.get('result'), updated=time.monotonic())
                item['event'].set()
                return self.respond(200, {'ok': True})
            if parsed.path != '/command':
                return self.respond(404, {'error': 'not found'})
            target, batch = data.get('target'), data.get('batch')
            if not isinstance(target, str) or target not in s.clients:
                return self.respond(409, {'error': 'target must be a currently connected client'})
            if not isinstance(batch, dict) or not isinstance(batch.get('operations'), list) or not 1 <= len(batch['operations']) <= 200:
                return self.respond(400, {'error': 'batch.operations must contain 1..200 operations'})
            if batch.get('expectedPageId') != s.clients[target]['pageId']:
                return self.respond(409, {'error': 'expectedPageId must match the connected page'})
            if len(s.jobs) >= MAX_JOBS:
                return self.respond(429, {'error': 'job storage full; allow old jobs to expire'})
            try:
                timeout = float(parse_qs(parsed.query).get('timeout', ['30'])[0])
                if not 0 <= timeout <= 180:
                    raise ValueError()
            except ValueError:
                return self.respond(400, {'error': 'timeout must be 0..180'})
            cid = uuid.uuid4().hex
            item = {'target': target, 'batch': batch, 'state': 'queued', 'updated': time.monotonic(), 'event': threading.Event()}
            s.jobs[cid] = item
        item['event'].wait(timeout)
        with s.lock:
            if item['state'] == 'done':
                return self.respond(200, {'id': cid, 'state': 'done', 'result': item['result']})
            if item['state'] == 'queued':
                item.update(state='cancelled', updated=time.monotonic())
                return self.respond(504, {'id': cid, 'state': 'cancelled', 'error': 'not picked up before timeout'})
            self.respond(202, {'id': cid, 'state': 'running', 'message': 'Do not resubmit; query /commands/' + cid})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, choices=[17658, 17659], default=17658)
    args = parser.parse_args()
    token = os.environ.get('FIGMA_BRIDGE_TOKEN') or secrets.token_urlsafe(32)
    if len(token) < 24 or not token.isascii() or any(c.isspace() for c in token):
        parser.error('FIGMA_BRIDGE_TOKEN must be at least 24 ASCII characters without whitespace')
    server = Bridge(('127.0.0.1', args.port), token)
    print('Local bridge: http://localhost:' + str(args.port), flush=True)
    print('Session token (paste into plugin; do not publish): ' + token, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
