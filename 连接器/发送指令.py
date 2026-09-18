"""CLI for the local bridge. Token is read from FIGMA_BRIDGE_TOKEN."""
import argparse
import json
import os
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from pathlib import Path

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', type=int, choices=[17658, 17659], default=17658)
    p.add_argument('--clients', action='store_true')
    p.add_argument('--status', help='command ID returned by the bridge')
    p.add_argument('--file', type=Path, help='UTF-8 JSON command envelope')
    p.add_argument('--timeout', type=float, default=30)
    p.add_argument('--output', type=Path, help='write JSON response to this file')
    a = p.parse_args()
    token = os.environ.get('FIGMA_BRIDGE_TOKEN')
    if not token:
        p.error('Set FIGMA_BRIDGE_TOKEN to the current bridge token')
    if sum([a.clients, bool(a.status), bool(a.file)]) != 1:
        p.error('Choose exactly one of --clients, --status or --file')
    path = '/clients' if a.clients else '/commands/' + a.status if a.status else '/command?timeout=' + str(a.timeout)
    body = None
    if a.file:
        body = json.dumps(json.loads(a.file.read_text(encoding='utf-8-sig')), ensure_ascii=False).encode('utf-8')
    req = Request('http://127.0.0.1:'+str(a.port)+path, data=body, headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urlopen(req, timeout=max(a.timeout+10, 15)) as response:
            code, data = response.status, json.load(response)
    except HTTPError as e:
        code, data = e.code, json.load(e)
    except OSError as e:
        print('Connection failed: '+str(e), file=sys.stderr)
        return 1
    result = json.dumps(data, ensure_ascii=False, indent=2)
    if a.output:
        a.output.write_text(result+'\n', encoding='utf-8')
    else:
        print(result)
    # 202 means still running, not success or permission to replay.
    if code == 202:
        return 2
    if code >= 400 or (isinstance(data.get('result'),dict) and data['result'].get('ok') is False):
        return 1
    return 0

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
