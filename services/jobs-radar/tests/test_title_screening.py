import json
import time

import pytest

from jobs_radar.board import Board
from jobs_radar.identity import identity, stable_id
from jobs_radar.screening import title_reason
from jobs_radar.store import Store
from test_store import observation


def row(key,title,kind='internship'):
    return {**observation(url='https://example.org/'+key),'source_id':key,'title':title,'kind':kind,
            'source_url':'https://example.org/source'}


def test_title_exclusions_are_atomic_visible_in_recycle_and_never_resurrect(tmp_path):
    store=Store(tmp_path/'titles.sqlite');board=Board(store)
    rows=[row('ds','Data Science Intern'),row('da','Data Analyst Intern - Summer 2027'),
          row('de','Data Engineering Intern'),row('ml','Machine Learning Engineer')]
    store.ingest('simplify:internship',rows,'sync',scoped_only=True)
    assert {j['title'] for j in board.list(kind='internship')['jobs']}=={'Data Engineering Intern','Machine Learning Engineer'}
    assert len(store.search(location='',kind='internship')['jobs'])==2
    trash=board.list(kind='internship',view='trash')['jobs']
    assert len(trash)==2
    for job in trash:
        assert job['review']['evidence'][0]['quote']==job['title']
        assert job['review']['version']==1
        from jobs_radar.extension_sync import ExtensionSync
        assert not ExtensionSync(store).resolve({'url':job['apply_url']})['queue']['allowed']
    with store.connect(True) as c:
        c.execute('UPDATE job_screening SET expires_at=?',(time.time()-1,))
    store.ingest('simplify:internship',rows,'resync',scoped_only=True)
    assert board.list(kind='internship',view='trash')['total']==0
    assert board.list(kind='internship')['total']==2
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM audit WHERE actor='sync-title-rule'").fetchone()[0]==2
        assert c.execute('SELECT sum(version) FROM applications').fetchone()[0]==0


def test_backfill_protects_processed_claimed_and_manually_restored_jobs(tmp_path):
    store=Store(tmp_path/'protected.sqlite');board=Board(store)
    rows=[row(k,'Data Scientist Intern') for k in ['submitted','claimed','restored','pending']]
    store.ingest('simplify:internship',rows,'legacy')
    ids={r['source_id']:stable_id(identity(r['apply_url'])) for r in rows}
    board.mark_submitted(ids['submitted'],0,'Owner success receipt','submitted-role')
    with store.connect(True) as c:c.execute("UPDATE applications SET status='in_progress' WHERE job_id=?",(ids['claimed'],))
    j=next(j for j in board._rows('internship') if j['id']==ids['restored'])
    evidence=[{'url':j['source_url'],'quote':j['title'],'observed_at':'2026-09-16T00:00:00Z'}]
    board.review(j['id'],'internship','trash','data_science','Title exclusion',evidence,j['fingerprint'],0,'delete-restored')
    board.review(j['id'],'internship','restore','','Owner restored',[],j['fingerprint'],1,'restore-role',actor='web-owner')
    with store.connect() as c:
        before=[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    assert store.screen_titles()=={'newgrad':0,'internship':1}
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    store.ingest('simplify:internship',rows,'resync',scoped_only=True)
    with store.connect() as c:
        assert before==[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        assert c.execute("SELECT state FROM job_screening WHERE job_id=?",(ids['restored'],)).fetchone()[0]=='keep'


def test_new_title_gate_failure_rolls_back_source_snapshot(tmp_path,monkeypatch):
    import jobs_radar.screening as screening
    store=Store(tmp_path/'rollback.sqlite')
    def fail(*args):
        raise RuntimeError('Simulated screening failure')
    monkeypatch.setattr(screening,'screen_titles',fail)
    with pytest.raises(RuntimeError):
        store.ingest('simplify:internship',[row('ds','Data Science Intern')],'sync',scoped_only=True)
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM jobs').fetchone()[0]==0


def test_title_rule_uses_job_title_not_category_or_description():
    assert title_reason('Junior Systems Developer and Data Analyst')=='data_analyst'
    assert title_reason('Data Scientist Intern')=='data_science'
    assert title_reason('Data Engineering Intern') is None
    assert title_reason('Machine Learning Engineer') is None


@pytest.mark.parametrize('title',['Software PhD Internships','NVIDIA Ph.D. Research Intern','SWE Intern - BS/MS/PhD','ph.d intern'])
def test_phd_titles_are_excluded_even_when_mixed_degree(title):
    assert title_reason(title)=='phd'


def test_phd_removed_before_publication_and_backfilled_without_losing_history(tmp_path):
    store=Store(tmp_path/'phd.sqlite');board=Board(store)
    for kind in ('newgrad','internship'):
        rows=[row(kind+'-phd','Software PhD Internships',kind),
              {**row(kind+'-normal','Software Engineer',kind),'description':'BS, MS or PhD welcome'},
              row(kind+'-master','Software Engineering Masters Internships',kind)]
        store.ingest('simplify:'+kind,rows,'sync',scoped_only=True)
        assert board.list(kind=kind)['total']==2
        trash=board.list(kind=kind,view='trash')['jobs']
        assert len(trash)==1 and trash[0]['review']['reason']=='phd'
        assert len(store.search(kind=kind,location='')['jobs'])==2
        store.ingest('simplify:'+kind,rows,'repeat',scoped_only=True)
        assert board.list(kind=kind)['total']==2
    legacy=[row('old-phd','Software Engineer - Ph.D.'),row('submitted-phd','Research PhD Intern')]
    store.ingest('speedyapply:SWE:internship',[{**r,'source':'speedyapply'} for r in legacy],'legacy')
    submitted=stable_id(identity(legacy[1]['apply_url']))
    board.mark_submitted(submitted,0,key='phd-existing-submission')
    assert store.screen_titles()=={'newgrad':0,'internship':1}
    assert store.get_jobs([submitted])[0]['status']=='submitted'


@pytest.mark.parametrize('title',[
    'AI Merchandise Pricer','Business Analyst Intern - Consumer Business Group',
    'Service Sales Intern - IB Focus','Inside Sales Representative',
    'AI Video Creator & Editor','AI Content Creator','Video Editor Intern',
    'Video Producer','Content Editor',
])
def test_occupational_relevance_is_not_a_hardcoded_title_gate(title):
    assert title_reason(title) is None


@pytest.mark.parametrize('title',[
    'AI Engineer - Merchandise Pricer Platform','Sales Software Engineer',
    'Software Engineer - Business Analyst Tools','Quantitative Research Analyst',
    'Developer Support Associate','Data Engineer','AI Research Intern',
    'Marketing Technology Intern','Robotics Controls & Autonomy Intern',
    'Video/Image AI/ML Software Engineer Intern - Multimedia',
    'Software Engineer - Creator Business','Video Algorithms Intern - Video Coding',
    'Software Engineer - Video Editor','Research Scientist - Video Generation',
])
def test_occupation_rule_does_not_expand_to_ambiguous_or_technical_roles(title):
    assert title_reason(title) is None


def test_semantic_judgment_accepts_unlisted_occupation_and_stays_suppressed(tmp_path):
    store=Store(tmp_path/'semantic.sqlite');board=Board(store)
    source=row('unlisted','Brand Storytelling Associate','newgrad')
    store.ingest('simplify:newgrad',[source],'seed',scoped_only=True)
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    job=board.list()['jobs'][0]
    evidence=[{'url':job['source_url'],'quote':job['title'],'observed_at':'2026-09-17T00:00:00Z'}]
    result=board.review(job['id'],'newgrad','trash','off_target_role',
        'This occupation creates brand communications rather than technical engineering or research.',
        evidence,job['fingerprint'],0,'semantic-unlisted-role')
    assert result['state']=='trash'
    store.ingest('simplify:newgrad',[source],'resync',scoped_only=True)
    assert not board.list()['jobs']
    assert store.get_jobs([job['id']])[0]['status']=='not_started'


@pytest.mark.parametrize('quote,url',[
    ('Invented responsibilities','https://github.com/SimplifyJobs/New-Grad-Positions'),
    ('AI Video Creator & Editor','https://unrelated.example.org/job'),
])
def test_semantic_removal_rejects_unanchored_evidence(tmp_path,quote,url):
    store=Store(tmp_path/'evidence.sqlite');board=Board(store)
    store.ingest('simplify:newgrad',[row('creator','AI Video Creator & Editor','newgrad')],'seed')
    job=board.list()['jobs'][0]
    with pytest.raises(ValueError,match='exact current title'):
        board.review(job['id'],'newgrad','trash','off_target_role','Content creation, not technical development',
            [{'url':url,'quote':quote,'observed_at':'2026-09-17T00:00:00Z'}],job['fingerprint'],0,'bad-evidence-key')
    assert board.list()['jobs'][0]['screening']=='pending'


def test_semantic_review_preserves_mixed_occupations(tmp_path):
    store=Store(tmp_path/'conflict.sqlite');board=Board(store)
    source=row('mixed','AI Video Creator & Editor','newgrad')
    store.ingest('simplify:newgrad',[source],'seed',scoped_only=True)
    store.ingest('speedyapply:AI:newgrad',[{**source,'source':'speedyapply','title':'Software Engineer - Video Editor'}],'seed',scoped_only=True)
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    job=board.list()['jobs'][0]
    board.review(job['id'],'newgrad','review','uncertain','Sources disagree on content creation versus software development',
        [],job['fingerprint'],0,'conflict-review-key')
    assert board.list()['jobs'][0]['screening']=='review'


def test_content_creator_corrected_by_ai_without_sync_keyword_rule(tmp_path):
    store=Store(tmp_path/'creator.sqlite');board=Board(store)
    source=row('creator','AI Video Creator & Editor','newgrad')
    store.ingest('simplify:newgrad',[source],'seed',scoped_only=True)
    job=board.list()['jobs'][0]
    board.review(job['id'],'newgrad','keep','eligible','Previous narrow triage',[],
                 job['fingerprint'],0,'old-creator-keep')
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    board.review(job['id'],'newgrad','trash','off_target_role','The role creates and edits videos; AI is a production tool, not an engineering occupation.',
        [{'url':job['source_url'],'quote':job['title'],'observed_at':'2026-09-17T00:00:00Z'}],
        job['fingerprint'],1,'ai-creator-correction')
    assert not board.list()['jobs']
    store.ingest('simplify:newgrad',[source],'resync',scoped_only=True)
    assert not board.list()['jobs']
