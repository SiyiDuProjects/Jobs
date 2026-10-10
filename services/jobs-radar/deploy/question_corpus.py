"""Private question-corpus export, annotation and synthetic baseline evaluation.

No real Profile is read. Provider requests require --live; run those on the
server with its existing provider configuration. Files remain under .qa/.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import tempfile

from jobs_radar.question_corpus import QuestionCorpus, question_key
from jobs_radar.store import Store


def private_path(value):
    path = Path(value).resolve()
    if '.qa' not in path.parts:
        raise ValueError('Corpus files must stay under an ignored .qa directory')
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def export(store, output):
    corpus = QuestionCorpus(store)
    offset, pages = 0, []
    while True:
        result = corpus.export(offset)
        pages.extend(result['pages'])
        if result['next'] is None:
            break
        offset = result['next']
    save(output, dict(version=1, source='private-server-corpus', pages=pages,
                      labels=result['labels'], bindings=result['bindings'], corrections=result['corrections']))
    return dict(pages=len(pages), bindings=len(result['bindings']), labelled=len(result['labels']))


def identities():
    source=Path(__file__).resolve().parents[1]/'jobs_radar'/'corpus-identities.json'
    for raw in json.loads(source.read_text()):
        profile=dict(profileName='Synthetic '+raw['id'],nameData={},addressData={},contactData={},jobData=[],educationData=[],languageData=[],resumeData={},websiteData={},skillsData=[],employmentData={},applicationData={})
        profile.update({k:v for k,v in raw.items() if k!='id'})
        yield raw['id'],profile


def replay_hash(value):
    import hashlib
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def invariants(key, identity, field, row, profile=None):
    failures = []
    value, decision = row.get('value'), row.get('decision')
    if value is not None and field['options']:
        allowed = {o['value'] for o in field['options']}
        values = value if isinstance(value, list) else [value]
        if any(not isinstance(v, str) or v not in allowed for v in values):
            failures.append('option_not_offered')
    # Empty employment history is an explicit negative under the owner's rule.
    if identity == 'unknown' and value is not None and decision == 'write' and row.get('route') != 'previous_employer':
        failures.append('unknown_fact_answered')
    # All baseline identities have no exact dates.
    if value is not None and field['type'] == 'date':
        failures.append('invented_date')
    if decision == 'draft':
        if not row.get('route','').startswith('draft.'):
            failures.append('fact_as_draft')
        from jobs_radar.draft_quality import sample_issues
        failures.extend(sample_issues(value,field,profile or {}))
    return [dict(questionId=key, identity=identity, rule=rule) for rule in failures]


async def baseline(input_path, output, limit, live, client=None):
    from jobs_radar.answers import Answers
    from jobs_radar.profiles import Profiles
    from jobs_radar.ai_answers import INSTRUCTIONS
    from jobs_radar.luna_screening import MODEL
    from jobs_radar.field_answers import fields_input
    try:
        from .verify_reported_questions import as_field
    except ImportError:
        from verify_reported_questions import as_field
    corpus=json.loads(input_path.read_text());results=[];calls=0;skipped=[]
    revision={'promptHash':replay_hash(INSTRUCTIONS),'model':MODEL}
    raw_profiles=json.loads((Path(__file__).resolve().parents[1]/'jobs_radar'/'corpus-identities.json').read_text())
    cases=[];known=set()
    for page in corpus['pages']:
        for original in page['page']['fields']:
            key=question_key(original)
            if key not in known and len(known)>=limit: continue
            known.add(key);field=as_field(original)
            try: fields_input({'fields':[field]})
            except ValueError: skipped.append({'pageId':page['id'],'questionId':key});continue
            cases.append((page['id'],key,field))
    with tempfile.TemporaryDirectory(prefix='jobs-corpus-synthetic-') as temp:
        store=Store(Path(temp)/'synthetic.sqlite');service=Answers(store,flow='simple')
        for identity,profile in identities():
            record=Profiles(store).save(profile)
            profile_hash=replay_hash(next(p for p in raw_profiles if p['id']==identity))
            for page in corpus['pages']:
                selected=[(key,field) for pid,key,field in cases if pid==page['id']]
                for start in range(0,len(selected),20):
                    batch=selected[start:start+20];rows={}
                    if live:
                        # The test DB has its own budget; real service counters are untouched.
                        with store.connect(True) as c:
                            if c.execute("SELECT 1 FROM sqlite_master WHERE name='answer_requests'").fetchone(): c.execute('DELETE FROM answer_requests')
                        response=await service.generate(dict(profileId=record['id'],profileVersion=record['last_sync'],answerProtocol=3,fields=[f for _,f in batch],additionalContext='Synthetic replay; captured platform: '+page['page']['platform']),client)
                        rows={r['fieldId']:r for r in response['answers']};calls+=response['answerUsage']['modelCalls']
                    for key,field in batch:
                        row=rows.get(field['fieldId'],{'kind':'unknown','value':None})
                        options={o['value']:o['label'] for o in field['options']};value=row.get('value')
                        value=[options.get(v,v) for v in value] if isinstance(value,list) else options.get(value,value)
                        results.append(dict(pageId=page['id'],questionId=key,identity=identity,profileHash=profile_hash,**revision,answer={**row,'value':value}))
    summary=dict(questions=len(known),identities=4,providerCalls=calls,unanswered=sum(r['answer']['kind']=='unknown' for r in results),captureGaps=len(skipped))
    save(output,dict(version=2,syntheticFactsOnly=True,live=live,summary=summary,results=results,captureGaps=skipped))
    if live: save(output.with_suffix('.corpus.json'),{**corpus,'aiRevision':revision,'aiAnswers':results})
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    exporting = commands.add_parser('export')
    exporting.add_argument('--database', required=True)
    exporting.add_argument('--output', required=True)
    labelling = commands.add_parser('label', help='Store an independently reviewed mapping, never a personal answer')
    labelling.add_argument('--database', required=True)
    labelling.add_argument('--input', required=True, help='.qa JSON with questionId, binding and meaning')
    testing = commands.add_parser('baseline')
    testing.add_argument('--input', required=True)
    testing.add_argument('--output', required=True)
    testing.add_argument('--limit', type=int, default=30)
    testing.add_argument('--live', action='store_true', help='Explicitly authorize provider calls using synthetic facts')
    args = parser.parse_args()
    if args.command in {'export', 'label'}:
        if not Path(args.database).is_file():
            raise ValueError('Existing corpus database required')
        store = Store(Path(args.database))
        if args.command == 'export':
            summary = export(store, private_path(args.output))
        else:
            annotation = json.loads(private_path(args.input).read_text())
            QuestionCorpus(store).label(annotation['questionId'], {k: annotation[k] for k in ('binding', 'meaning')})
            summary = {'labelled': 1}
    else:
        if not 1 <= args.limit <= 1000:
            raise ValueError('Limit must be 1..1000')
        summary = asyncio.run(baseline(private_path(args.input), private_path(args.output), args.limit, args.live))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
