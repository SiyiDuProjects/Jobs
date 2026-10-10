"""Run reported real question structures against a real provider in an isolated DB.

Run on the server. Source DB is read-only. The authorized answer projection goes
to the existing model provider; reports stay in the private server directory. This
checks comprehension and the response contract, not successful writes to an ATS.
"""
import argparse
import asyncio
import copy
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import zlib

from jobs_radar.answers import Answers
from jobs_radar.field_answers import fields_input
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.management import Management

URLS = {
    'handshake':'https://jobs.ashbyhq.com/handshake/42aca7f5-2f58-40ef-a6ce-19027d32a12f/application',
    'lucid':'https://lucidmotors.com/careers/search/5242854007?gh_jid=5242854007',
    'proofpoint':'https://proofpoint.wd5.myworkdayjobs.com/en-US/proofpointcareers/job/Texas/AI-Engineer-II_R14847',
    'northrop':'https://ngc.wd1.myworkdayjobs.com/en-US/northrop_grumman_external_site/job/United-States-California-El-Segundo/Software-Engineer--Level-1-2-_R10251286',
}
CAPTURES = {
    'northrop':'f06da7b731a7a5b8ad65ded18d494e30737f7ca0ff04146b17e6c0c858582003',
    'lucid':'0515415f581823131a0cdff764b90c8d527790f944f50263df1952054fb5003e',
    'handshake':'6542e6f74d473adf170af7be2179ea00cfd8b735897ddd705987d3f6d7bc112c',
    'proofpoint':'63a78f2022d131623b0bb9d1e1369e7ecbf9a238f84045f27172ba025f393647',
}
OLD_HISTORY_NOTE = 'The listed internships are not a complete inventory of all employment, contracting or volunteering.'
CURRENT_HISTORY_NOTE = 'Company employment/contracting history in jobData and these notes is complete; no matching company/affiliate means never worked there.'


def choose_pages(connection):
    pages={}
    for name,ident in CAPTURES.items():
        row=connection.execute('SELECT payload FROM corpus_pages WHERE id=?',(ident,)).fetchone()
        if not row: raise ValueError('Missing reported capture: '+name)
        raw=row[0]
        page=json.loads(zlib.decompress(raw))
        pages[name]=(ident,page)
    return pages


def selected(name, question):
    q=question.lower()
    if name=='handshake': return any(s in q for s in ('onsite and','authorized to work','require sponsorship'))
    if name=='lucid': return any(s in q for s in ('for lucid','highest level','authorized to work','visa sponsorship','compensation range','communications via sms'))
    if name=='proofpoint': return 'check one of the boxes' in q
    return any(s in q for s in ('private sector','government','northrop grumman','at least 18','willing to relocate','export control','citizen of another','security clearance','false claims act','suspended or debarred')) and 'date' not in q.replace('today’s date','')


def as_field(raw):
    f={key:copy.deepcopy(raw[key]) for key in ('question','description','type','required','options')}
    f['fieldId']=raw['id']
    if not f['options']:
        observation=next((v for v in reversed(raw.get('observations',[])) if not v.get('query')),None)
        if observation: f['options']=[{'value':'recorded-'+str(i),'label':v} for i,v in enumerate(observation['options'])]
    if f['type']=='combobox' and not f['options']: f['type']='search-choice'
    return f


def expected(field, profile):
    q=field['question'].lower();app=profile.get('applicationData',{});emp=profile.get('employmentData',{})
    labels=[v['label'] for v in field['options']]
    def option(pattern):
        hits=[v for v in labels if re.search(pattern,v,re.I)]
        return hits[0] if len(hits)==1 else None
    if 'onsite and' in q: return option('^yes$' if app.get('willingToWorkOnsite') is True else '^no$') if 'willingToWorkOnsite' in app else None
    if 'at least 18' in q and isinstance(emp.get('age'),(int,float)): return option('^yes$' if emp['age']>=18 else '^no$')
    if 'willing to relocate' in q and isinstance(app.get('willingToRelocate'),bool): return option('^yes$' if app['willingToRelocate'] else '^no$')
    if 'export control' in q and app.get('visaStatus')=='F-1' and emp.get('citizenships') and 'United States' not in emp['citizenships']: return option('^none of the above$')
    if 'authorized to work' in q: return option('^yes$' if emp['eligibilityUS'] else '^no$') if 'eligibilityUS' in emp else None
    if 'sponsorship' in q:
        value=app.get('sponsorshipNow') is True or app.get('sponsorshipFuture') is True
        return option('^yes$' if value else '^no$') if value or app.get('sponsorshipNow') is False and app.get('sponsorshipFuture') is False else None
    if 'compensation range' in q and app.get('salaryPreference')=='posted_range': return 'Within the posted salary range'
    if 'highest level' in q and app.get('highestCompletedEducation')=='High School': return option('^high school diploma')
    if 'security clearance' in q and 'clearance' in app.get('defaultAnswers',[]): return option('^no, never')
    if 'government' in q and 'government' in app.get('defaultAnswers',[]): return option('^no$')
    if ('for lucid' in q or 'employed by northrop' in q) and not any(re.search('lucid|northrop',r.get('company',''),re.I) for r in profile.get('jobData',[])):
        return option('never been|^no$')
    if 'check one of the boxes' in q and emp.get('disability') is False: return option('^no, i do not')
    return None


async def run(database, output, current_history_policy=False):
    source=sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True)
    pages=choose_pages(source); results=[]
    profiles={json.loads(raw)['profileName']:(pid,json.loads(raw)) for pid,raw in source.execute('SELECT id,profile FROM owner_profiles WHERE deleted=0')}
    with tempfile.TemporaryDirectory(prefix='reported-questions-') as folder:
        store=Store(Path(folder)/'isolated.sqlite');service=Answers(store);Management(store)
        for name,(ident,page) in pages.items():
            pid,profile=profiles['Intern' if name=='northrop' else 'Newgrad']
            profile=copy.deepcopy(profile)
            if current_history_policy:
                notes=profile.get('applicationData',{}).get('aiNotes','')
                profile['applicationData']['aiNotes']=notes.replace(OLD_HISTORY_NOTE,CURRENT_HISTORY_NOTE)
            record=Profiles(store).save(profile,profile_id=pid,allow_create=True)
            # Keep only the bound Profile's saved-response document.
            document=source.execute('SELECT value,revision FROM management_documents WHERE key=?',('jobsResponses:'+pid,)).fetchone()
            if document:
                with store.connect(True) as c:
                    c.execute('INSERT OR REPLACE INTO management_documents(key,value,revision) VALUES(?,?,?)',('jobsResponses:'+pid,document[0],document[1]))
            fields=[as_field(f) for f in page['fields'] if selected(name,f['question']) and (f['required'] or f['options'])]
            validated=[]
            for f in fields:
                try: fields_input({'fields':[f]});validated.append(f)
                except ValueError as error: raise ValueError('Unsupported capture: '+name+'/'+f['fieldId']) from error
            for start in range(0,len(validated),30):
                batch=validated[start:start+30]
                response=await service.generate({'profileId':pid,'profileVersion':record['last_sync'],'fields':batch,'jobCountry':'US','jobUrl':URLS[name],'jobTitle':page.get('step',''),'additionalContext':'Company: '+name})
                for f,row in zip(batch,response['answers']):
                    values=row.get('value');options={o['value']:o['label'] for o in f['options']}
                    readable=[options.get(v,v) for v in values] if isinstance(values,list) else options.get(values,values)
                    gold=expected(f,profile)
                    results.append({'page':name,'corpusId':ident,'profileId':pid,'profileVersion':record['last_sync'],'field':f,'answer':row,
                                    'expected':gold,'expectedMatch':readable==gold if gold is not None else None,
                                    'chinese':bool(re.search('[\u3400-\u9fff]',row.get('questionZh',''))) and bool(re.search('[\u3400-\u9fff]',row.get('reason','')))})
                print(json.dumps({'page':name,'checked':min(start+30,len(validated)),'total':len(validated),'providerCalls':response['answerUsage']['modelCalls']}),flush=True)
    report={'realQuestions':True,'realProvider':True,'realATSWrite':False,'profilesModified':False,'currentHistoryPolicy':current_history_policy,'pages':list(pages),'results':results}
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(output,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f: json.dump(report,f,ensure_ascii=False,indent=2)
    summary={'questions':len(results),'checkedExpected':sum(r.get('expectedMatch') is not None for r in results),
             'wrongExpected':sum(r.get('expectedMatch') is False for r in results),'unanswered':sum(r.get('answer',{}).get('value') is None for r in results),
             'chinese':sum(r.get('chinese',False) for r in results),'unsupported':sum('error' in r for r in results)}
    print(json.dumps({'summary':summary}),flush=True)
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--live',action='store_true',required=True)
    parser.add_argument('--current-history-policy',action='store_true',help='Apply the owner-confirmed history wording to isolated Profile copies')
    args=parser.parse_args();summary=asyncio.run(run(args.database,args.output,args.current_history_policy))
    raise SystemExit(2 if summary['wrongExpected'] or summary['unsupported'] else 0)
