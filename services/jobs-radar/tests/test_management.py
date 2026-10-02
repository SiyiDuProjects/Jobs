import json
import uuid
import pytest
from starlette.testclient import TestClient
from jobs_radar.store import Store
from jobs_radar.profiles import Profiles,ProfileConflict
from jobs_radar.management import Management
from jobs_radar.extension_sync import ExtensionSync,EXTENSION_ID
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess

@pytest.fixture
def subject(tmp_path):
    s=Store(tmp_path/'manage.sqlite');Profiles(s);return s,Management(s)

def test_revision_conflict_batch_atomicity_and_reversible_deletion(subject):
    s,m=subject
    initial=m.write([{'key':'dailyGoal','value':20,'revision':0},{'key':'settings','value':{},'revision':0}])
    assert initial['dailyGoal']['revision']==1
    assert m.write([{'key':'dailyGoal','value':20,'revision':0}])==initial
    with pytest.raises(ProfileConflict):m.write([{'key':'settings','value':{'a':1},'revision':1},{'key':'dailyGoal','value':30,'revision':0}])
    assert m.snapshot()==initial
    m.write([{'key':'dailyGoal','value':30,'revision':1}])
    with s.connect() as c:assert json.loads(c.execute("SELECT value FROM management_revisions WHERE key='dailyGoal'").fetchone()[0])==20

def test_credentials_unsupported_keys_and_invalid_records_never_stored(subject):
    _,m=subject
    for key,value in [('jobsSyncV1',{}),('autofillAccount',{}),('settings',{'nested':{'accountPassword':'secret'}}),('appliedList',[{}]),('dailyGoal',True)]:
        with pytest.raises(ValueError):m.write([{'key':key,'value':value,'revision':0}])
    assert m.snapshot()=={'appliedList':{'value':[],'revision':0}}

def test_manage_auth_cookie_csrf_scope_and_no_public_data(subject):
    s,m=subject;origin='https://radar.test';server=create_server(s,origin)
    device=str(uuid.uuid4());receipts=ExtensionSync(s).pair(device,EXTENSION_ID);token=Profiles(s).grant(device)
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as c:
        assert c.get('/api/manage/state').status_code==401
        assert c.get('/api/manage/state',headers={'Authorization':'Bearer '+receipts['token']}).status_code==401
        assert c.get('/api/manage/state',headers={'Authorization':'Bearer '+token}).status_code==200
        session=c.get('/api/session').json();WebAccess(s,origin).approve(session['request_id'])
        assert c.post('/api/manage/state',json={'changes':[]},headers={'origin':'https://evil.test'}).status_code==403
        assert c.post('/api/manage/state',json={'changes':[{'key':'dailyGoal','revision':0,'value':12}]},headers={'origin':origin}).status_code==200
        assert c.get('/api/manage/state').json()['dailyGoal']['value']==12
        before=m.snapshot()
        retired=c.post('/api/manage/state',json={'changes':[{'key':'appliedList','revision':0,'value':[]}]},headers={'origin':origin})
        assert retired.status_code==426 and retired.json()['code']=='client_upgrade_required'
        assert m.snapshot()==before
        assert c.get('/manage/../web.py').status_code!=200
        assert c.get('/manage/custom/private-connection.js').status_code==404
