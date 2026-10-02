"""Actual restricted ASGI/domain/database behavior with synthetic v2 data only."""
import hashlib
import json
from pathlib import Path
import sqlite3
import shutil
import sys
import time

import pytest
from starlette.testclient import TestClient

from jobs_radar.client_protocol import CURRENT_HEADERS
from jobs_radar.recovery_server import create_app, existing
from jobs_radar.restricted_recovery import (prepare, export_resume, fingerprint, RecoveryStore,
    WRITABLE, SETTING_KEYS, CODE, connection, guards, file_hash, active_recovery, write_marker, clear_marker)
from jobs_radar.web import COOKIE, WebAccess
from jobs_radar.profiles import Profiles
from jobs_radar.management import Management
from test_legacy_recovery import databases

ORIGIN = 'https://jobs.siyidu.com'


@pytest.fixture
def recovered(databases, tmp_path):
    source = databases['current']
    with sqlite3.connect(source) as db:
        db.execute('INSERT INTO web_sessions VALUES(?,?,?,?,1)', (hashlib.sha256(b'owner-cookie').hexdigest(), 'synthetic-approved', time.time(), time.time()+3600))
    (tmp_path/'migrations').mkdir()
    bundle = tmp_path/'migrations/restricted-abcdef123456'
    before = fingerprint(source)
    report = prepare(source, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    assert fingerprint(source) == before
    assert fingerprint(bundle/'current-v2.sqlite') == before
    app = create_app(bundle, ORIGIN)
    with TestClient(app, base_url=ORIGIN, headers={**CURRENT_HEADERS, 'Origin':ORIGIN}) as client:
        client.cookies.set(COOKIE, 'owner-cookie')
        yield dict(data=databases, bundle=bundle, report=report, app=app, client=client, before=before)


def test_complete_latest_data_is_preserved_and_execution_is_held(recovered):
    item = recovered
    assert item['report']['oldRuntimeStarted'] is False
    assert item['report']['restoreProof'] == 'all-tables-equal-before-execution-hold'
    assert {'static/board.js', 'static/board.css'} <= set(item['report']['runtime'])
    for name in ['applications','application_events','owner_submission_undo','management_documents','owner_profiles','owner_profile_revisions']:
        assert fingerprint(item['bundle']/'recovery.sqlite', selected={name})[name] == item['before'][name]
    with connection(item['bundle']/'recovery.sqlite', readonly=True) as db:
        states = dict(db.execute('SELECT id,state FROM browser_control_commands'))
        assert states == {'queued':'cancelled','sent':'unknown'}
        assert db.execute('SELECT active FROM browser_control_sessions').fetchone()[0] == 0
        assert db.execute('SELECT status FROM applications WHERE job_id=?', (item['data']['unknown']['job_id'],)).fetchone()[0] == 'submitted_unconfirmed'
        assert db.execute('SELECT deleted FROM applications WHERE application_id=?', (item['data']['removed']['application_id'],)).fetchone()[0] == 1


def test_owner_profile_settings_reads_and_optimistic_writes_work_in_global_release_pause(recovered, monkeypatch):
    monkeypatch.setattr('jobs_radar.maintenance.paused', lambda: True)
    client = recovered['client']
    assert client.get('/api/session').json()['authenticated']
    record = client.get('/api/manage/profiles/'+recovered['data']['profile']['id']).json()
    original_attachment = record['profile']['resumeData']
    record['profile']['profileName'] = 'Changed during restricted recovery'
    response = client.put('/api/manage/profiles/'+record['id'], json=dict(profile=record['profile'], expected_sync=record['last_sync']))
    assert response.status_code == 200, response.text
    checked = client.get('/api/manage/profiles/'+record['id']).json()
    assert checked['profile']['profileName'] == record['profile']['profileName']
    assert checked['profile']['resumeData'] == original_attachment
    assert client.put('/api/manage/profiles/'+record['id'], json=dict(profile={**record['profile'], 'profileName':'Stale'}, expected_sync=record['last_sync'])).status_code == 409
    docs = client.get('/api/manage/state').json()
    response = client.post('/api/manage/state', json={'changes':[dict(key='settings', value={'automatic':False}, revision=docs['settings']['revision'])]})
    assert response.status_code == 200 and response.json()['settings']['value'] == {'automatic':False}
    assert response.json()['appliedList']['value']
    (recovered['bundle']/'.pause-profile-writes').touch()
    assert client.get('/api/manage/profiles').status_code == 200
    assert client.post('/api/manage/state', json={'changes':[]}).status_code == 503
    assert client.put('/api/manage/profiles/'+record['id'], json=dict(profile=checked['profile'], expected_sync=checked['last_sync'])).status_code == 503


@pytest.mark.parametrize('path', [
    '/mcp','/api/extension/events','/api/extension/control','/api/extension/resolve',
    '/api/extension/connect','/api/extension/profiles','/api/extension/profiles/anything',
    '/api/extension/storage-migrations','/api/manage/applications','/api/manage/progress',
    '/api/manage/answer/jobs','/api/manage/answer','/api/actions','/api/ext/sync/profile',
    '/api/ext/sync/profile/list','/api/unknown-future-writer',
])
def test_all_application_and_unknown_routes_fail_before_body_or_side_effect(recovered, path):
    before = fingerprint(recovered['bundle']/'recovery.sqlite')
    for method in ['GET','POST','PUT','DELETE']:
        response = recovered['client'].request(method, path, content=b'invalid JSON, must not parse')
        assert response.status_code == 503
        assert response.json()['code'] == CODE
    assert fingerprint(recovered['bundle']/'recovery.sqlite') == before


def test_cookie_origin_and_protocol_are_required_and_device_grants_are_not_enough(recovered):
    client = recovered['client']
    client.cookies.clear()
    client.headers['Authorization'] = 'Bearer '+'x'*64
    assert client.get('/api/manage/profiles').status_code == 401
    client.cookies.set(COOKIE, 'owner-cookie')
    assert client.post('/api/manage/state', json={'changes':[]}, headers={'Origin':'https://other.invalid'}).status_code == 403
    client.headers.pop('X-Jobs-Protocol')
    assert client.post('/api/manage/state', json={'changes':[]}).status_code == 426


def test_owner_can_sign_in_without_starting_normal_server_or_workers(recovered):
    client = recovered['client']; client.cookies.clear()
    pending = client.get('/api/session').json()
    assert pending['authenticated'] is False
    access = existing(WebAccess, recovered['app'].state.recovery_store, origin=ORIGIN)
    access.approve(pending['request_id'])
    assert client.get('/api/session').json()['authenticated'] is True
    assert client.get('/api/manage/profiles').status_code == 200


def test_settings_batch_cannot_hide_application_writes_and_direct_db_guards_cover_every_other_table(recovered):
    client = recovered['client']; docs = client.get('/api/manage/state').json()
    response = client.post('/api/manage/state', json={'changes':[
        dict(key='settings', value={'automatic':False}, revision=docs['settings']['revision']),
        dict(key='appliedList', value=[], revision=0)]})
    assert response.status_code == 503 and client.get('/api/manage/state').json()['settings'] == docs['settings']
    with sqlite3.connect(recovered['bundle']/'recovery.sqlite') as db:
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in set(tables)-WRITABLE:
            with pytest.raises(sqlite3.IntegrityError, match=CODE):
                db.execute('INSERT INTO "'+table.replace('"','""')+'" DEFAULT VALUES')
        for key in ['appliedList','jobsResponses:not-a-profile-id','unknown-future-key']:
            with pytest.raises(sqlite3.IntegrityError, match=CODE):
                db.execute('INSERT OR REPLACE INTO management_documents VALUES(?,?,1)', (key,'[]'))
        with pytest.raises(sqlite3.IntegrityError, match=CODE): db.execute('INSERT INTO audit DEFAULT VALUES')
    with recovered['app'].state.recovery_store.connect() as db:
        with pytest.raises(sqlite3.DatabaseError): db.execute('DROP TABLE applications')
        with pytest.raises(sqlite3.DatabaseError): db.execute('CREATE TABLE unknown_writer(value)')


def test_saved_profile_responses_use_the_existing_normalizer_without_application_writes(recovered):
    client = recovered['client']; key='jobsResponses:'+recovered['data']['profile']['id']
    before=fingerprint(recovered['bundle']/'recovery.sqlite', selected=set(recovered['report']['frozen']))
    row=dict(key='synthetic',keywords=[' Synthetic ','Topic'],appearances=1,response=' Original answer ')
    saved=client.post('/api/manage/state',json={'changes':[dict(key=key,value=[row],revision=0)]})
    assert saved.status_code==200
    document=saved.json()[key]
    assert document['value'][0]['keywords']==['synthetic','topic']
    assert document['value'][0]['response']=='Original answer'
    row={**document['value'][0], 'response':'Edited answer'}
    changed=client.post('/api/manage/state',json={'changes':[dict(key=key,value=[row],revision=document['revision'])]})
    assert changed.status_code==200 and changed.json()[key]['value'][0]['response']=='Edited answer'
    invalid=client.post('/api/manage/state',json={'changes':[dict(key=key,value=[{**row,'keywords':[]}],revision=changed.json()[key]['revision'])]})
    assert invalid.status_code==400
    missing=client.post('/api/manage/state',json={'changes':[dict(key='jobsResponses:aaaaaaaa-1111-4222-8333-444444444444',value=[row],revision=0)]})
    assert missing.status_code==409
    assert fingerprint(recovered['bundle']/'recovery.sqlite',selected=set(recovered['report']['frozen']))==before


def test_shared_route_api_default_still_honors_global_maintenance(monkeypatch):
    from starlette.applications import Starlette
    from jobs_radar.recovery_server import Routes
    from jobs_radar.http_routes import RouteAPI
    router=Routes(); invoked=[]
    @RouteAPI(router).route('/ordinary',['POST'],lambda request:True)
    async def ordinary(request,payload,principal):
        invoked.append(True); return {'ok':True}
    monkeypatch.setattr('jobs_radar.maintenance.paused',lambda:True)
    with TestClient(Starlette(routes=router.routes),headers=CURRENT_HEADERS) as client:
        assert client.post('/ordinary',json={}).status_code==503
    assert invoked==[]


def test_resume_exports_latest_profile_and_settings_without_replaying_application_data(recovered):
    client = recovered['client']; docs = client.get('/api/manage/state').json()
    client.post('/api/manage/state', json={'changes':[dict(key='settings',value={'automatic':False},revision=docs['settings']['revision'])]}).raise_for_status()
    record = client.get('/api/manage/profiles/'+recovered['data']['profile']['id']).json()
    record['profile']['profileName'] = 'Recovery edit kept on resume'
    client.put('/api/manage/profiles/'+record['id'], json=dict(profile=record['profile'],expected_sync=record['last_sync'])).raise_for_status()
    with pytest.raises(ValueError, match='Pause Profile'): export_resume(recovered['bundle'])
    (recovered['bundle']/'.pause-profile-writes').touch()
    with pytest.raises(RuntimeError, match='Stop the recovery server'): export_resume(recovered['bundle'])
    client.__exit__(None, None, None)
    report = export_resume(recovered['bundle'])
    assert report['resumeDatabase'] == 'resume-v2.sqlite'
    with connection(recovered['bundle']/'resume-v2.sqlite', readonly=True) as db:
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE 'restricted_recovery_%'").fetchone()
        assert json.loads(db.execute('SELECT profile FROM owner_profiles WHERE id=?',(record['id'],)).fetchone()[0])['profileName'] == 'Recovery edit kept on resume'
        assert json.loads(db.execute("SELECT value FROM management_documents WHERE key='settings'").fetchone()[0]) == {'automatic':False}
    assert fingerprint(recovered['bundle']/'resume-v2.sqlite', selected=set(recovered['report']['frozen'])) == recovered['report']['frozen']
    assert fingerprint(recovered['bundle']/'current-v2.sqlite') == recovered['before']


def test_missing_guard_runtime_drift_and_failed_prepare_never_activate(recovered, tmp_path, monkeypatch):
    with sqlite3.connect(recovered['bundle']/'recovery.sqlite') as db:
        db.execute('DROP TRIGGER restricted_recovery_applications_INSERT')
    with pytest.raises(ValueError, match='guards'): RecoveryStore(recovered['bundle'])
    with pytest.raises(ValueError, match='guards'): export_resume(recovered['bundle'])
    with pytest.raises(FileExistsError): prepare(recovered['data']['current'], recovered['bundle'], release='a'*12, image_id='sha256:'+'b'*64)
    monkeypatch.setattr('jobs_radar.restricted_recovery.copy_database', lambda *args: (_ for _ in ()).throw(TimeoutError('synthetic deadline')))
    failed = tmp_path/'failed'
    with pytest.raises(TimeoutError): prepare(recovered['data']['current'], failed, release='a'*12,image_id='sha256:'+'b'*64)
    assert (failed/'FAILED').exists()
    with pytest.raises(ValueError, match='failed'): RecoveryStore(failed)


def test_runtime_mismatch_and_interrupted_export_never_publish(recovered, monkeypatch):
    import jobs_radar.restricted_recovery as module
    original = module.runtime_files
    monkeypatch.setattr(module,'runtime_files',lambda: {**original(), 'synthetic-code-drift':'changed'})
    with pytest.raises(ValueError, match='runtime'): RecoveryStore(recovered['bundle'])
    monkeypatch.setattr(module,'runtime_files',original)
    recovered['client'].__exit__(None,None,None)
    (recovered['bundle']/'.pause-profile-writes').touch()
    copy = module.copy_database
    def interrupted(source,destination,deadline):
        copy(source,destination,deadline)
        raise TimeoutError('synthetic interrupted export')
    monkeypatch.setattr(module,'copy_database',interrupted)
    with pytest.raises(TimeoutError): export_resume(recovered['bundle'])
    assert not (recovered['bundle']/'resume-v2.sqlite').exists()
    assert (recovered['bundle']/'resume-v2.sqlite.partial').exists()
    assert fingerprint(recovered['bundle']/'current-v2.sqlite')==recovered['before']


def test_oversized_historical_row_fails_before_python_materializes_it(databases,tmp_path):
    from jobs_radar.restricted_recovery import MAX_ROW_BYTES
    with sqlite3.connect(databases['current']) as db:
        db.execute('INSERT INTO management_revisions VALUES(?,?,zeroblob(?),?)',('settings',99,MAX_ROW_BYTES+1,0))
    bundle=tmp_path/'oversized'
    with pytest.raises(sqlite3.DataError,match='too big'):
        prepare(databases['current'],bundle,release='a'*12,image_id='sha256:'+'b'*64)
    assert (bundle/'FAILED').exists() and (bundle/'current-v2.sqlite').exists()
    assert not (bundle/'manifest.json').exists()
    with sqlite3.connect(databases['current']) as db:
        assert db.execute("SELECT length(value) FROM management_revisions WHERE key='settings' AND revision=99").fetchone()[0]==MAX_ROW_BYTES+1


def activate(recovered):
    database=recovered['data']['current']
    (database.parent/'.release-maintenance').touch()
    recovered['client'].__exit__(None,None,None)
    write_marker(database,recovered['bundle'],release='a'*12,image_id='sha256:'+'b'*64)
    return database,database.parent/'.restricted-recovery.json'


def test_marker_requires_stopped_service_and_complete_identity(recovered):
    database=recovered['data']['current']
    with pytest.raises(ValueError,match='global release'): write_marker(database,recovered['bundle'],release='a'*12,image_id='sha256:'+'b'*64)
    (database.parent/'.release-maintenance').touch()
    with pytest.raises(RuntimeError,match='Stop the recovery'): write_marker(database,recovered['bundle'],release='a'*12,image_id='sha256:'+'b'*64)
    recovered['client'].__exit__(None,None,None)
    with pytest.raises(ValueError,match='identity'): write_marker(database,recovered['bundle'],release='c'*12,image_id='sha256:'+'b'*64)
    write_marker(database,recovered['bundle'],release='a'*12,image_id='sha256:'+'b'*64)
    assert active_recovery(database)==recovered['bundle']
    assert write_marker(database,recovered['bundle'],release='a'*12,image_id='sha256:'+'b'*64)['bundle']=='migrations/restricted-abcdef123456'


@pytest.mark.parametrize('invalid', ['{"version":1,"version":1}', '{}', '[]', 'x'*4097])
def test_invalid_marker_cannot_fall_back_to_normal_cli(recovered,monkeypatch,invalid):
    from jobs_radar import cli
    database,marker=activate(recovered)
    marker.write_text(invalid)
    monkeypatch.setattr(cli,'Store',lambda path: (_ for _ in ()).throw(AssertionError('Normal Store must not open')))
    monkeypatch.setattr(sys,'argv',['jobs','--db',str(database),'serve'])
    with pytest.raises(ValueError): cli.main()


@pytest.mark.parametrize('change',[
    {'bundle':'../restricted-abcdef123456'}, {'bundle':'migrations/restricted-too-short'},
    {'bundle':'/data/migrations/restricted-abcdef123456'}, {'release':'c'*12},
    {'imageId':'sha256:'+'c'*64}, {'manifestSha256':'0'*64}, {'extra':'ignored?'}])
def test_marker_rejects_escape_and_mismatched_manifest(recovered,change):
    database,marker=activate(recovered)
    value=json.loads(marker.read_text()); value.update(change); marker.write_text(json.dumps(value))
    with pytest.raises((ValueError,FileNotFoundError)): active_recovery(database)


def test_cli_routes_recovery_before_normal_store_and_preserves_default_when_absent(recovered,monkeypatch):
    from jobs_radar import cli,server
    import uvicorn
    database,marker=activate(recovered); served=[]
    monkeypatch.setattr(uvicorn,'run',lambda app,**options: served.append(app))
    monkeypatch.setattr(sys,'argv',['jobs','--db',str(database),'serve'])
    monkeypatch.setattr(cli,'Store',lambda path: (_ for _ in ()).throw(AssertionError('Normal Store must not open')))
    cli.main()
    assert served[-1].state.recovery_store.path==recovered['bundle']/'recovery.sqlite'
    for command in ['status','backup']:
        monkeypatch.setattr(sys,'argv',['jobs','--db',str(database),command]+(['out.sqlite'] if command=='backup' else []))
        with pytest.raises(RuntimeError,match='permits only'): cli.main()
    marker.unlink()
    normal=object(); monkeypatch.setattr(cli,'Store',lambda path:normal)
    class Ordinary:
        def streamable_http_app(self): return 'ordinary-app'
    monkeypatch.setattr(server,'create_server',lambda store:Ordinary() if store is normal else None)
    monkeypatch.setattr(sys,'argv',['jobs','--db',str(database),'serve'])
    cli.main(); assert served[-1]=='ordinary-app'


def test_clear_marker_requires_latest_promoted_export_and_keeps_global_pause(recovered):
    database,marker=activate(recovered)
    (recovered['bundle']/'.pause-profile-writes').touch()
    with pytest.raises(FileNotFoundError): clear_marker(database)
    # Distinguish recovery edits from the original even if there were no new
    # application rows; an old snapshot must never pass the promotion check.
    with sqlite3.connect(recovered['bundle']/'recovery.sqlite') as db:
        db.execute("UPDATE management_documents SET value='{\"automatic\":false}',revision=4 WHERE key='settings'")
    exported=export_resume(recovered['bundle'])
    assert export_resume(recovered['bundle'])==exported
    with pytest.raises(ValueError,match='exact latest'): clear_marker(database)
    assert marker.exists()
    shutil.copyfile(recovered['bundle']/'resume-v2.sqlite',database)
    assert clear_marker(database)['markerCleared'] is True
    assert active_recovery(database) is None
    assert (database.parent/'.release-maintenance').is_file()
