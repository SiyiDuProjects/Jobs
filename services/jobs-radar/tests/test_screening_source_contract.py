import json
import time

import httpx

from jobs_radar.company_screening import public_input, SOURCE_FIELDS
from jobs_radar.luna_screening import classify
from jobs_radar.sources import configured_streams, simplify_rows, speedy_rows
from test_luna_screening import reply


def test_both_parsers_preserve_all_public_screening_facts_at_provider_boundary():
    now=time.time()
    streams=configured_streams(2027)
    raw={'id':'degree-regression','company_name':'Autodesk','title':'Research Intern - Multimodal AI',
         'url':'https://example.org/research','active':True,'is_visible':True,
         'locations':['Boston, MA'],'category':'AI/ML/Data','date_posted':now-60,
         'terms':['Summer 2027'],'degrees':['PhD'],'sponsorship':'Other','source':'Simplify'}
    a=simplify_rows(next(s for s in streams if s.id=='simplify:internship'),[raw],observed_at=now)[0]
    content='''## Other
| Company | Position | Location | Salary | Application | Posting Age |
| --- | --- | --- | --- | --- | --- |
| Autodesk | Research Intern | Boston, MA | $40/hr | <a href="https://example.org/research">Apply</a> | 0d |
'''
    b=speedy_rows(next(s for s in streams if s.id=='speedyapply:SWE:internship'),content,now)[0]
    # Explicitly account for every normalized parser field. New parser fields
    # must be classified as public job facts or ingestion metadata here.
    metadata={'source','kind','file','active','visible','h1b','apply_url_status','posted_at',
              'time_precision','country_scope','source_id','collection_scope','updated_at',
              'upstream_source','raw','posting_age'}
    assert not set(SOURCE_FIELDS)&metadata
    for s in (a,b):assert set(s)<=set(SOURCE_FIELDS)|metadata
    row={'id':'job','kind':'internship','company':'Autodesk','title':a['title'],
         'all_sources':[a,b],'status':'private status','profile':'private profile'}
    captured=[]
    def provider(request):
        payload=json.loads(request.content);inputs=json.loads(payload['input']);captured.extend(inputs)
        return httpx.Response(200,json=reply(inputs))
    with httpx.Client(transport=httpx.MockTransport(provider)) as client:classify(client,[row])
    sent=captured[0]['sources']
    assert sent[0]['degrees']==['PhD'] and sent[1]['degrees'] is None
    assert sent[0]['terms']==['Summer 2027'] and sent[1]['salary']=='$40/hr'
    assert sent[0]['sponsorship']=='Other' and sent[1]['sponsorship'] is None
    assert all(s['apply_url']=='https://example.org/research' and s['source_url'] for s in sent)
    assert sent[0]['description']=='' and sent[0]['description_complete'] is False
    assert all('raw' not in s for s in sent)
    assert 'private' not in json.dumps(captured)


def test_available_description_is_transmitted_and_can_support_model_evidence():
    description='Primary work is manual testing and customer technical support.'
    source={'company':'Example','title':'Technical Associate','locations':['USA'],
            'description':description,'description_complete':True,'source_url':'https://example.org/job'}
    row={'id':'job','kind':'newgrad','company':'Example','title':source['title'],'all_sources':[source]}
    assert public_input(row,'job_0')['sources'][0]['description']==description
    def provider(request):
        payload=json.loads(request.content)
        assert description in payload['text']['format']['schema']['properties']['jobs']['properties']['job_0']['properties']['evidence_quote']['enum']
        value={'jobs':{'job_0':{'decision':'trash','reason':'Primary occupation is support','evidence_quote':description}}}
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(value)}]}]})
    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        assert classify(client,[row])[0][0]['reason_code']=='off_target_role'
