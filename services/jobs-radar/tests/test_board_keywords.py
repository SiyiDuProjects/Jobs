import pytest
from jobs_radar.board import Board, engineering_title
from jobs_radar.store import Store
from jobs_radar.geography import matches_region
from test_store import observation


@pytest.mark.parametrize('location,expected',[
    ('Seattle, WA',True),('NYC',True),('Boston, MA +1',True),
    ('Remote - USA',True),('SF',True),('Washington, DC',False),
    ('Washington, PA',False),('Canada',False),('Remote',True),
    ('Dallas, TX',True),('Toronto, Canada +1',False),
])
def test_focus_region_explicit_matches(location,expected):
    assert matches_region([location],'focus_remote') is expected


@pytest.mark.parametrize('title,expected',[
    ('AI Merchandise Pricer',False),('Developer Support Associate',False),
    ('MedTech Field Service Software Tech',False),('Salesforce Developer',False),
    ('Software Engineer - AI & Data Systems',True),('AI Frameworks Engineer',True),
    ('Quantitative Trading Summer Analyst',True),('Machine Learning Intern',True),
    ('Data Engineering Intern',True),('Engineering Intern',False),
    ('PhD Research Intern - Generative AI',False),
])
def test_title_filter_is_explicit_and_not_source_category(title,expected):
    assert engineering_title(title) is expected


def test_optional_keyword_filters_apply_before_pagination_and_preserve_state(tmp_path):
    s=Store(tmp_path/'keywords.sqlite');b=Board(s)
    titles=['Data Engineer Intern','Data Engineering Intern','Data-Engineer',
            'AI Software Engineer','Paid Software Engineer','Software Engineer - AI & Data Systems']
    for kind in ['newgrad','internship']:
        s.ingest('simplify:'+kind,[{**observation(url='https://example.org/'+str(i)),
            'source_id':str(i),'title':title,'kind':kind,'locations':['NYC']}
            for i,title in enumerate(titles)],'fixture')
    for kind in ['newgrad','internship']:
        result=b.list(kind=kind,region='focus_remote',exclude_data_engineering='1',page_size=1)
        assert result['total']==3 and len(result['jobs'])==1
        # Literal whole words: AI must not match the substring in Paid.
        result=b.list(kind=kind,exclude_data_engineering='1',exclude_titles='AI，C++')
        assert [r['title'] for r in result['jobs']]==['Paid Software Engineer']
        assert b.list(kind=kind)['total']==6
        assert b.list(kind=kind,category='engineering',exclude_data_engineering='1')['total']==3
    with s.connect() as c:
        assert c.execute("SELECT count(*) FROM applications WHERE version>0").fetchone()[0]==0
        assert c.execute("SELECT count(*) FROM job_screening WHERE state='trash'").fetchone()[0]==0
    with pytest.raises(ValueError):b.list(exclude_data_engineering='true')
    with pytest.raises(ValueError):b.list(exclude_titles='x'*257)
