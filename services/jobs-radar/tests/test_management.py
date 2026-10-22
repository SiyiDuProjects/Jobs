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
    key = 'jobsResponses:' + str(uuid.uuid4())
    initial=m.write([{'key':key,'value':[],'revision':0},{'key':'settings','value':{},'revision':0}])
    assert initial[key]['revision']==1
    assert m.write([{'key':key,'value':[],'revision':0}])==initial
    with pytest.raises(ProfileConflict):m.write([{'key':key,'value':[{'key':'test','response':'Synthetic','fromAutofill':False}],'revision':1},{'key':'settings','value':{'a':1},'revision':0}])
    assert m.snapshot()==initial
    m.write([{'key':'settings','value':{'a':1},'revision':1}])
    with s.connect() as c:assert json.loads(c.execute("SELECT value FROM management_revisions WHERE key='settings'").fetchone()[0])=={}

def test_credentials_unsupported_keys_and_invalid_records_never_stored(subject):
    _,m=subject
    for key,value in [('jobsSyncV1',{}),('autofillAccount',{}),('settings',{'nested':{'accountPassword':'secret'}}),('appliedList',[{}]),('dailyGoal',True),('dailyGoal',20),('configList',[]),('boardCardOrder',{})]:
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
        assert c.post('/api/manage/state',json={'changes':[{'key':'settings','revision':0,'value':{'autofillSettings':{'autoSubmit':False}}}]},headers={'origin':origin}).status_code==200
        assert c.get('/api/manage/state').json()['settings']['value']['autofillSettings']['autoSubmit'] is False
        before=m.snapshot()
        retired=c.post('/api/manage/state',json={'changes':[{'key':'appliedList','revision':0,'value':[]}]},headers={'origin':origin})
        assert retired.status_code==426 and retired.json()['code']=='client_upgrade_required'
        assert m.snapshot()==before
        assert c.get('/manage/../web.py').status_code!=200
        assert c.get('/manage/custom/private-connection.js').status_code==404


def test_history_compresses_deduplicates_and_restores_legacy_inline_versions(subject):
    s,m=subject
    a={'fixture':'repeated synthetic text '*500}
    b={'fixture':'another synthetic text '*500}
    for revision,value in enumerate((a,b,a,b)):
        m.write([{'key':'settings','value':value,'revision':revision}],include_applications=False)
    assert [row['value'] for row in m.history('settings')] == [a,b,a]
    with s.connect() as c:
        assert c.execute('SELECT count(*) FROM management_revision_blobs').fetchone()[0] == 2
        assert c.execute('SELECT sum(length(payload)) FROM management_revision_blobs').fetchone()[0] < len(json.dumps(a))
    # Existing JSON revisions remain readable and can be compacted explicitly.
    with s.connect(True) as c:
        c.execute('INSERT INTO management_revisions VALUES(?,?,?,?)',('settings',0,json.dumps(a),0))
    assert m.history('settings')[0]['value'] == a
    assert m.compact_history()['compacted'] == 1
    assert m.compact_history()['compacted'] == 0
    assert [row['value'] for row in m.history('settings')] == [a,a,b,a]
    with s.connect(True) as c:
        c.execute('UPDATE management_revision_blobs SET raw_bytes=raw_bytes+1')
    with pytest.raises(ValueError,match='integrity'):m.history('settings')


def test_scoped_revision_snapshot_returns_only_changed_requested_documents(subject):
    _,m=subject
    pid=str(uuid.uuid4());key='jobsResponses:'+pid
    m.write([{'key':'settings','revision':0,'value':{}},{'key':key,'revision':0,'value':[]}])
    assert m.snapshot(keys=['settings'],revisions={'settings':1},include_applications=False)=={}
    assert m.snapshot(keys=[key],include_applications=False)=={key:{'value':[],'revision':1}}
    for params in ({'keys':['appliedList']},{'keys':'settings'},{'revisions':{'settings':True}},{'revisions':[]}):
        with pytest.raises(ValueError):m.snapshot(include_applications=False,**params)


def test_history_compaction_cursor_advances_past_incompressible_rows(subject,monkeypatch):
    from jobs_radar import management_history
    from jobs_radar.release_compatibility import data_contract
    s,m=subject
    a={'synthetic':'a'*2000}; b={'synthetic':'b'*2000}
    with s.connect(True) as c:
        c.executemany('INSERT INTO management_revisions VALUES(?,?,?,?)', [('settings',1,json.dumps(a),0),('settings',2,json.dumps(b),0)])
    pack=management_history.pack
    monkeypatch.setattr(management_history,'pack',lambda c,raw:raw if json.loads(raw)==a else pack(c,raw))
    first=m.compact_history(1)
    assert first['compacted']==0 and first['next_cursor']==['settings',1]
    second=m.compact_history(1,first['next_cursor'])
    assert second['compacted']==1
    assert [r['value'] for r in m.history('settings')]==[a,b]
    assert data_contract()['management_history']=='zlib-sha256-v1'


def test_reused_corrupt_history_blob_cannot_replace_current_document(subject):
    s,m=subject
    a={'synthetic':'a'*2000}; b={'synthetic':'b'*2000}
    for revision,value in enumerate((a,b,a)):
        m.write([{'key':'settings','revision':revision,'value':value}],include_applications=False)
    before=m.snapshot(include_applications=False)
    with s.connect(True) as c:
        c.execute("UPDATE management_revision_blobs SET payload=x'0000'")
    with pytest.raises(ValueError,match='integrity'):
        m.write([{'key':'settings','revision':3,'value':b}],include_applications=False)
    assert m.snapshot(include_applications=False)==before
    with s.connect(read_only=True) as c:
        assert not c.execute("SELECT 1 FROM management_revisions WHERE key='settings' AND revision=3").fetchone()
