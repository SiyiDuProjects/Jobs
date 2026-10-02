"""Offline stdio transport to real ASGI routes; synthetic integration fixture only."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1]))
from starlette.testclient import TestClient
from jobs_radar.client_protocol import CURRENT_HEADERS
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.management import Management
from jobs_radar.profiles import Profiles
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_profile_contract import fixture


def main():
    store = Store(Path(sys.argv[1]) / 'bridge.sqlite')
    device = 'aaaaaaaa-1111-4222-8333-444444444444'
    ExtensionSync(store).pair(device, EXTENSION_ID)
    profiles = Profiles(store); token = profiles.grant(device)
    saved = profiles.save(fixture()); record = profiles.get(saved['id'])
    management = Management(store)
    management.write([dict(key='jobsResponses:' + saved['id'], value=[], revision=0)])
    with store.connect(True) as c:
        c.execute('INSERT INTO management_documents VALUES(?,?,1)', ('settings', json.dumps({'premiumSettings': {'responseContext': 'Server synthetic context', 'keep': 4}})))
    server = create_server(store, 'https://jobs.siyidu.com')
    if len(sys.argv) > 2 and sys.argv[2] == 'interrupt-saga':
        original = Profiles.save
        pending = [True]
        def fail_after_commit(self, *args, **kwargs):
            result = original(self, *args, **kwargs)
            if pending[0]:
                pending[0] = False
                raise OSError('synthetic transport loss after domain commit')
            return result
        Profiles.save = fail_after_commit
    with TestClient(server.streamable_http_app(), base_url='https://jobs.siyidu.com', headers={**CURRENT_HEADERS, 'authorization': 'Bearer ' + token}) as client:
        print(json.dumps(dict(deviceId=device, record=record)), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            if request.get('inspect'):
                value = dict(profiles=[profiles.get(row['id']) for row in profiles.list()], management=management.snapshot())
                print(json.dumps(dict(status=200, value=value)), flush=True)
                continue
            try:
                response = client.request(request['method'], request['path'], json=request.get('body'))
            except OSError:
                print(json.dumps(dict(status=503, value={'code': 'synthetic_after_commit_failure'})), flush=True)
                continue
            print(json.dumps(dict(status=response.status_code, value=response.json())), flush=True)


if __name__ == '__main__': main()
