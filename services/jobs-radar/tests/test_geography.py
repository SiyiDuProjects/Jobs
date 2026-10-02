import time
import pytest
from jobs_radar.geography import matches_region
from jobs_radar.board import Board
from jobs_radar.store import Store
from test_store import observation


@pytest.mark.parametrize('locations,ca,remote',[
    (['San Francisco, CA'],True,True),(['SF'],True,True),
    (['Santa Clara, CA +2'],True,True),(['Bay Area'],True,True),
    (['US-California-Santa-Clara'],True,True),
    (['NYC','Mountain View, CA'],True,True),
    (['Chicago, IL'],False,False),(['Canada'],False,False),
    (['California, MD'],False,False),(['Remote - Canada'],False,False),
    (['Remote - USA'],False,True),(['Remote in USA','Minneapolis, MN'],False,True),
    (['Remote - USA excluding CA'],False,False),(['Remote - NY'],False,False),
    (['Remote'],False,False),(['United States'],False,False),
    (['Boston, MA +1'],False,False),([],False,False),
])
def test_explicit_location_matching(locations,ca,remote):
    assert matches_region(locations,'ca') is ca
    assert matches_region(locations,'ca_remote') is remote
    assert matches_region(locations,'') is True


@pytest.mark.parametrize('locations',[['USA'],['United States'],['US'],[],['Remote'],['TBD']])
def test_focus_preset_keeps_unresolved_us_locations(locations):
    assert matches_region(locations,'focus_remote')
    assert not matches_region(locations,'ca')


def test_focus_preset_does_not_relax_explicit_foreign_or_other_state_locations():
    for locations in (['Canada'],['London, UK'],['Chicago, IL'],['Remote - Canada']):
        assert not matches_region(locations,'focus_remote')


def test_region_combines_with_date_status_and_kind_without_deleting(tmp_path):
    s=Store(tmp_path/'geo.sqlite');b=Board(s)
    jobs=[{**observation(url='https://example.org/'+str(i)),'source_id':str(i),'locations':loc} for i,loc in enumerate([['SF'],['Boston, MA'],['Remote - USA']])]
    for kind in ['newgrad','internship']:s.ingest('simplify:'+kind,[{**j,'kind':kind} for j in jobs],'fixture')
    for kind in ['newgrad','internship']:
        assert b.list(kind=kind,region='ca',status='recent')['total']==1
        assert b.list(kind=kind,region='ca_remote',status='recent')['total']==2
        assert b.list(kind=kind,region='',status='recent')['total']==3
    row=b.list(region='ca')['jobs'][0]
    b.mark_submitted(row['id'],0,key='geo-submit')
    assert b.list(region='ca',status='recent')['jobs'][0]['status']=='submitted'
    assert b.list(region='ca',status='not_started')['total']==0
    assert b.list(region='ca',status='recent',added_since=time.time()+1)['total']==0
    with s.connect() as c:assert c.execute("SELECT count(*) FROM job_screening WHERE state='trash'").fetchone()[0]==0
    with pytest.raises(ValueError):b.list(region='unknown')
