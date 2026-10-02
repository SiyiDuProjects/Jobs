import uuid
import pytest
from starlette.testclient import TestClient
from jobs_radar.store import Store
from jobs_radar.extension_sync import ExtensionSync,EXTENSION_ID
from jobs_radar.profiles import Profiles,ProfileConflict
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from jobs_radar.client_protocol import CURRENT_HEADERS

def profile(name='SWE'):
    return {'profileName':name,'nameData':{'firstName':'Test','lastName':'Person'},'addressData':{},'contactData':{},'jobData':[],
            'educationData':[],'languageData':[],'resumeData':{},'websiteData':{},'employmentData':{}}

@pytest.fixture
def subject(tmp_path):
    s=Store(tmp_path/'profiles.sqlite');e=ExtensionSync(s);p=Profiles(s)
    return s,e,p

def test_crud_contract_and_restart(subject):
    s,_,p=subject
    first=p.save(profile())
    second=p.save(profile('ML'))
    p=Profiles(Store(s.path))
    assert p.list()==[{'id':first['id'],'profileName':'SWE'},{'id':second['id'],'profileName':'ML'}]
    assert p.get(first['id'])['profile']==profile()
    assert p.get(first['id'])['last_sync']==first['last_sync']
    deleted=p.delete(second['id'],expected_sync=second['last_sync'])
    assert deleted['id']==first['id'] and deleted['profile']==profile()
    with s.connect() as c:assert c.execute('SELECT deleted FROM owner_profiles WHERE id=?',(second['id'],)).fetchone()[0]==1
    with pytest.raises(ValueError):p.delete(first['id'],expected_sync=first['last_sync'])

def test_idempotent_migration_and_conflict_preserve_both_versions(subject):
    s,_,p=subject;pid=str(uuid.uuid4())
    initial=p.save(profile(),profile_id=pid,allow_create=True)
    assert p.save(profile(),profile_id=pid,allow_create=True)==initial
    updated=p.save(profile('Updated'),profile_id=pid,expected_sync=initial['last_sync'])
    assert updated['last_sync']!=initial['last_sync']
    with pytest.raises(ProfileConflict):p.save(profile('Stale'),profile_id=pid,expected_sync=initial['last_sync'])
    assert p.get(pid)['profile']['profileName']=='Updated'
    with s.connect() as c:assert c.execute('SELECT count(*) FROM owner_profile_revisions').fetchone()[0]==1

def test_no_passwords_or_bad_ids(subject):
    _,_,p=subject
    for value in [{**profile(),'accountPassword':'secret'},{**profile(),'contactData':{'password':'secret'}},{}]:
        with pytest.raises(ValueError):p.save(value)
    with pytest.raises(ValueError):p.get('bad')
    with pytest.raises(ValueError):p.save([])
    assert not hasattr(p,'request')

def test_dedicated_scope_and_disconnect(subject):
    _,e,p=subject;device=str(uuid.uuid4());pair=e.pair(device,EXTENSION_ID);token=p.grant(device)
    assert p.authenticate(pair['token']) is None
    assert e.authenticate(token) is None
    assert p.authenticate(token)==device
    e.disconnect(device);assert p.authenticate(token) is None

def test_profile_http_requires_explicit_pair_scope(subject):
    s,_,_=subject;origin='https://radar.test';server=create_server(s,origin)
    with TestClient(server.streamable_http_app(),base_url=origin,headers=CURRENT_HEADERS) as c:
        body={'profile':profile()}
        assert c.post('/api/extension/profiles',json=body).status_code==401
        rid=c.get('/api/session').json()['request_id'];WebAccess(s,origin).approve(rid)
        pairing={'device_id':str(uuid.uuid4()),'extension_id':EXTENSION_ID}
        original=c.post('/api/extension/connect',json=pairing,headers={'origin':origin}).json()
        assert 'profile_token' not in original
        assert c.post('/api/extension/profiles',json=body,headers={'authorization':'Bearer '+original['token']}).status_code==401
        scoped=c.post('/api/extension/connect',json={**pairing,'profiles':True},headers={'origin':origin}).json()
        headers={'authorization':'Bearer '+scoped['profile_token']}
        assert c.get('/api/extension/profiles',headers=headers).json()==[]
        c.cookies.clear()
        created=c.post('/api/extension/profiles',json={'profile':profile()},headers=headers)
        assert created.status_code==200 and 'last_sync' in created.json()
        assert c.get('/api/jobs',headers=headers).status_code==401
