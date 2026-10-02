"""Explicit SSH administrator bridge for tasks without native Jobs Radar tools.

Pass a JSON file with method and args. Uses the same Store methods as MCP;
Browser methods reuse the existing opt-in BrowserControl contract. They cannot
enable it, bypass freshness/idempotency checks, or inject arbitrary scripts.
"""
import argparse
import json
import subprocess
from pathlib import Path

METHODS = {'search', 'get_jobs', 'filter_options', 'health', 'progress'}
BROWSER_METHODS = {'browser_pages': 'pages', 'browser_command': 'command', 'browser_command_status': 'get_command'}
PROGRESS_METHODS = {'application_states': 'list', 'update_application_progress': 'update', 'record_pending_email': 'record_pending_email'}
PRIVATE_READS = {'profiles': ('profiles', 'Profiles', 'agent_read'), 'browser_history': ('browser_history', 'Diagnostics', 'history')}
REMOTE_COMMAND = ('cd /home/ubuntu/siyi/jobs-radar && '
                  'flock -s -n .release.lock docker compose exec -T mcp python -')


def remote_code(request, *, all_pages=False):
    if (not isinstance(request, dict) or request.get('method') not in METHODS | BROWSER_METHODS.keys() | PROGRESS_METHODS.keys() | PRIVATE_READS.keys()
            or not isinstance(request.get('args', {}), dict)):
        raise ValueError('Unsupported method or args')
    if all_pages and request['method'] != 'search':
        raise ValueError('--all-pages is read-only search only')
    payload = json.dumps(request, ensure_ascii=True)
    code = ("import json,os\nfrom jobs_radar.maintenance import paused\n"
            "if paused(): raise RuntimeError('Release maintenance: administrator calls are paused')\n"
            "from jobs_radar.store import Store\nr=json.loads(" + repr(payload) + ")\ns=Store(os.environ['JOBS_DB'])\n")
    if request['method'] in BROWSER_METHODS:
        code += "from jobs_radar.browser_control import BrowserControl,enabled,observable\n"
        code += "if not observable(): raise RuntimeError('Remote observation is disabled')\n"
        code += "s=BrowserControl(s,allow_commands=enabled())\nr['method']=" + repr(BROWSER_METHODS[request['method']]) + "\n"
    elif request['method'] in PROGRESS_METHODS:
        code += "from jobs_radar.application_progress import ApplicationProgress\ns=ApplicationProgress(s)\n"
        code += "r['method']=" + repr(PROGRESS_METHODS[request['method']]) + "\n"
    elif request['method'] in PRIVATE_READS:
        module, name, method = PRIVATE_READS[request['method']]
        code += f"from jobs_radar.{module} import {name}\ns={name}(s)\nr['method']={method!r}\n"
    if all_pages:
        code += "a=r.get('args',{}); rows=[]\nfor page in range(100):\n d=s.search(**a); rows.extend(d['jobs'])\n if not d['next_cursor']: break\n a['cursor']=d['next_cursor']\nd['jobs']=rows\nprint(json.dumps(d,ensure_ascii=False))\n"
    else:
        code += "print(json.dumps(getattr(s,r['method'])(**r.get('args',{})),ensure_ascii=False))\n"
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request')
    parser.add_argument('--output')
    parser.add_argument('--all-pages', action='store_true', help='Read-only search pagination, capped at 100 pages')
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    code = remote_code(request, all_pages=args.all_pages)
    if args.output and request['method'] == 'profiles':
        raise ValueError('Profile facts are transient; do not save a local copy')
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-i',
        'C:/Users/Administrator/.ssh/Siyi.pem', 'ubuntu@49.51.38.235',
        REMOTE_COMMAND],
        input=code.encode(), capture_output=True, check=True, timeout=120)
    data = json.loads(result.stdout)
    if args.output:
        Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'saved': args.output, 'jobs': len(data.get('jobs', [])) if isinstance(data, dict) else None}))
    else:
        print(json.dumps(data, ensure_ascii=True))


if __name__ == '__main__':
    main()
