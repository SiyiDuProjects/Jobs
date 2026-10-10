import json
import time
from datetime import datetime, timezone
import pytest
from jobs_radar.store import Store
from jobs_radar.application_records import ApplicationRecords, counts, upsert
from jobs_radar.application_kind import backfill
from jobs_radar.application_progress import stage_label
from test_store import observation


def value(i, kind, profile='Shared'):
    return dict(jobTitle='Engineer', jobLink=f'https://jobs.ashbyhq.com/example/{i}', companyName='Example',
                companyLink='', date=datetime.now(timezone.utc).isoformat(), status='applied', profileName=profile, kind=kind)


def test_type_is_independent_of_profile_and_old_clients_cannot_erase_it(tmp_path):
    store=Store(tmp_path/'a.db'); records=ApplicationRecords(store)
    for i, kind in enumerate(['newgrad', 'internship', 'newgrad']):
        records.mutate([dict(action='create', value=value(i,kind,'Other' if i==2 else 'Shared'))],'create-kind-'+str(i))
    rows=records.list()['applications']
    first=next(r for r in rows if r['jobLink'].endswith('/0'))
    changed={**first, 'profileName':'Intern'}; changed.pop('kind')
    records.mutate([dict(action='update',application_id=first['id'],expected_version=first['version'],value=changed)],'edit-kind')
    with store.connect(True) as c:
        upsert(c,{**changed,'kind':'internship'})
    assert next(r for r in records.list()['applications'] if r['id']==first['id'])['kind']=='newgrad'
    now=time.time()
    assert counts(store,now-3600,now-86400,'newgrad')=={'today':2,'week':2}
    assert counts(store,now-3600,now-86400,'internship')=={'today':1,'week':1}
    assert counts(store,now-3600,now-86400)=={'today':3,'week':3}
    with pytest.raises(ValueError): counts(store,now-3600,now-86400,'other')


def test_legacy_kind_backfill_is_once_and_uses_posting_before_old_profile(tmp_path):
    store=Store(tmp_path/'a.db'); records=ApplicationRecords(store)
    source=observation(url='https://jobs.ashbyhq.com/example/0');source['kind']='internship'
    store.ingest('test:internship',[source],'seed')
    records.mutate([dict(action='create',value=value(0,'internship','Newgrad'))],'create-kind')
    with store.connect(True) as c:
        app=c.execute('SELECT * FROM applications WHERE record IS NOT NULL').fetchone()
        old=json.loads(app['record']);old.pop('kind')
        c.execute('UPDATE applications SET record=? WHERE job_id=?',(json.dumps(old),app['job_id']))
        c.execute("DELETE FROM schema_migrations WHERE name='application-employment-kind-v1'")
        backfill(c)
        fresh=c.execute('SELECT * FROM applications WHERE job_id=?',(app['job_id'],)).fetchone()
        assert json.loads(fresh['record'])['kind']=='internship'
        version=fresh['record_version'];backfill(c)
        assert c.execute('SELECT record_version FROM applications WHERE job_id=?',(app['job_id'],)).fetchone()[0]==version
    assert stage_label('phone_screen')=='HR 面试'


def test_new_untyped_external_application_never_uses_profile_name(tmp_path):
    store=Store(tmp_path/'a.db'); records=ApplicationRecords(store)
    row=value(0,'newgrad','Intern');row.pop('kind')
    records.mutate([dict(action='create',value=row)],'create-kind')
    assert records.list()['applications'][0]['kind']=='unknown'
