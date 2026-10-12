"""Private Profile-driven snapshot replay, not live ATS acceptance.

Run with the matching extension source and existing Node dependencies available
on the authorized server: --extension /path/to/extensions/speedyapply-local.
Source SQLite is one readonly transaction. The worker exchanges actual runtime
requests over private pipes; neither source Profiles nor the live service change.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import zlib
from jobs_radar.answers import Answers
from jobs_radar.ai_answers import INSTRUCTIONS, PROMPT_VERSION
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.management import Management
from jobs_radar.saved_answers import normalized, timestamp, company_key, request_context
from jobs_radar.profile_text import ENUM_TEXT
from verify_reported_questions import CAPTURES, expected as reported_expected
from jobs_radar.question_corpus import comparison_issues
from corpus_flow_replay import SnapshotReplay, posting_context, replay_code_hash


def private_save(path, value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd,'w') as f: json.dump(value,f,ensure_ascii=False,indent=2)


def gold_for(records, field, context, version):
    hits=[]
    for row in records:
        if not isinstance(row,dict) or row.get('origin')!='person' or normalized(row.get('question',''))!=normalized(field['question']): continue
        source=row.get('context') or {}
        if not isinstance(source,dict): continue
        if not context['companyKey'] or company_key(row.get('jobKey') or source.get('jobKey',''))!=context['companyKey']: continue
        date=timestamp(source.get('capturedAt'))
        if not date or date <= timestamp(version): continue
        if source.get('country','')!=context['country']: continue
        value=row.get('response')
        if field['options'] and value not in [o['label'] for o in field['options']]: continue
        hits.append((date,value))
    return max(hits,key=lambda v:v[0])[1] if hits else None


def answer_code_hash():
    root=Path(__file__).resolve().parents[1]/'jobs_radar'
    return hashlib.sha256(b''.join(p.name.encode()+p.read_bytes() for p in sorted(root.iterdir()) if p.is_file() and p.suffix in {'.py','.json'})).hexdigest()


def normalized_field(item):
    field = item['field']
    return {key: field.get(key, [] if key == 'options' else '')
            for key in ('fieldId', 'question', 'description', 'type', 'required', 'options')}


def effective_answer(item):
    """A model proposal is not an answer retained by the snapshot writer."""
    proposal = item.get('answer')
    value = item.get('retainedValue') if item.get('written') else None
    result = dict(proposal or {})
    result.update(kind=(proposal or {}).get('kind', 'answer') if value is not None else 'unknown',
                  value=value, stage=item['stage'], transport=item['transport'])
    if item['stage'] == 'local':
        result.update(source='local', reasonZh='资料经扩展本地规则写入快照',
                      questionZh='', answerZh='')
    elif proposal and proposal.get('value') is not None and value is None:
        result.update(interruptionReason='snapshot_write_failed',
                      reasonZh='模型已给出答案，但快照写入未成功；请查看录制选项和结构缺口')
    return result


def request_key(profile_id, corpus_id, flow, request, saved_answers_hash):
    return hashlib.sha256(json.dumps([profile_id, corpus_id, flow, request, saved_answers_hash],
                                     sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def run(args):
    if Path(args.database).resolve() == Path(args.output).resolve():
        raise ValueError('Report output must not replace the source database')
    source = sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    source.execute("BEGIN")
    captures = {ident: name for name, ident in CAPTURES.items()}
    failed_pages = set()
    if source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='corpus_failures'").fetchone():
        # Resolved failures remain regressions; markers never supply gold answers.
        failed_pages = {row[0] for row in source.execute('SELECT DISTINCT page_id FROM corpus_failures')}
    pages = [(ident, json.loads(zlib.decompress(raw)))
             for ident, raw in source.execute('SELECT id,payload FROM corpus_pages ORDER BY created')]
    profiles = list(source.execute("SELECT id,last_sync,profile FROM owner_profiles WHERE deleted=0 AND json_extract(profile,'$.profileName') IN ('Intern','Newgrad')"))
    if len(profiles) != 2:
        raise ValueError('Exactly the two authorized Profiles are required')
    if getattr(args, 'profile_name', None):
        profiles = [row for row in profiles if json.loads(row[2])['profileName'] == args.profile_name]
    if args.reported_only:
        pages = [(ident, page) for ident, page in pages if ident in captures or ident in failed_pages]
    code_hash = answer_code_hash()
    replay_hash = replay_code_hash(args.extension)
    cached = {}
    for path, only_flow in [(args.resume, None), (args.reuse_legacy, 'legacy')]:
        if not path:
            continue
        previous = json.loads(Path(path).read_text())
        if (previous.get('evaluationScope') != 'snapshot_pipeline'
                or previous.get('answerCodeHash') != code_hash
                or previous.get('replayCodeHash') != replay_hash):
            raise ValueError('Reuse requires the same complete snapshot pipeline and engine revision')
        cached.update({row['key']: row['response'] for row in previous.get('requests', [])
                       if not only_flow or row['flow'] == only_flow})
    results, gaps, failures, excluded, transcripts = [], [], [], [], []
    calls = {'legacy': 0, 'simple': 0}
    report = {
        'answerCodeHash': code_hash, 'replayCodeHash': replay_hash,
        'realProvider': True, 'realATSWrite': False, 'profilesModified': False,
        'originalUserAnswersRestored': False, 'adapterBindingsIncluded': False,
        'promptVersion': PROMPT_VERSION, 'promptHash': hashlib.sha256(INSTRUCTIONS.encode()).hexdigest(),
        'pages': len(pages), 'profileNames': [json.loads(row[2])['profileName'] for row in profiles],
        'evaluationScope': 'snapshot_pipeline', 'localRulesIncluded': True,
        'results': results, 'captureGaps': gaps, 'failures': failures,
        'excludedPages': excluded, 'requests': transcripts,
    }
    with tempfile.TemporaryDirectory(prefix='jobs-answer-comparison-') as temp:
        engines = {}
        for flow in calls:
            store = Store(Path(temp) / (flow + '.sqlite'))
            Profiles(store)
            Management(store)
            with store.connect(True) as connection:
                for pid, version, raw in profiles:
                    connection.execute('INSERT INTO owner_profiles(id,profile,last_sync,deleted) VALUES(?,?,?,0)',
                                       (pid, raw, version))
                    doc = source.execute('SELECT value,revision FROM management_documents WHERE key=?',
                                         ('jobsResponses:' + pid,)).fetchone()
                    if doc:
                        connection.execute('INSERT INTO management_documents(key,value,revision) VALUES(?,?,?)',
                                           ('jobsResponses:' + pid, doc[0], doc[1]))
            engines[flow] = (store, Answers(store, flow=flow))
        async with SnapshotReplay(args.extension, args.node) as replay:
            for ident, page in pages:
                issues = comparison_issues(page)
                if issues:
                    excluded.append({'page': ident, 'reasons': issues})
                    private_save(args.output, report)
                    continue
                job = posting_context(source, page)
                for pid, version, raw in profiles:
                    profile = json.loads(raw)
                    record = source.execute('SELECT value FROM management_documents WHERE key=?',
                                            ('jobsResponses:' + pid,)).fetchone()
                    records = json.loads(record[0]) if record else []
                    saved_answers_hash = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
                    pair = {}
                    for flow, (store, engine) in engines.items():
                        async def generate(request):
                            key = request_key(pid, ident, flow, request, saved_answers_hash)
                            if key in cached:
                                response = cached[key]
                            else:
                                # The source DB and live rate counter are never changed.
                                with store.connect(True) as connection:
                                    if connection.execute("SELECT 1 FROM sqlite_master WHERE name='answer_requests'").fetchone():
                                        connection.execute('DELETE FROM answer_requests')
                                try:
                                    response = await engine.generate(request)
                                except Exception as error:
                                    failures.append({'page': ident, 'profileId': pid, 'flow': flow,
                                                     'errorType': type(error).__name__})
                                    raise
                                calls[flow] += response['answerUsage']['modelCalls']
                            transcripts.append({'key': key, 'page': ident, 'profileId': pid, 'flow': flow,
                                                'request': request, 'response': response})
                            private_save(args.output, report)
                            return response
                        try:
                            pair[flow] = await replay.run(page, profile,
                                {'id': pid, 'lastSync': version}, job, generate)
                        except Exception as error:
                            failures.append({'page': ident, 'profileId': pid, 'flow': flow,
                                             'errorType': type(error).__name__})
                            pair[flow] = {'fields': [], 'gaps': [], 'blocked': []}
                        for gap in pair[flow]['gaps']:
                            gaps.append({'page': ident, 'profileId': pid, 'flow': flow, **gap})
                        for reason in pair[flow].get('blocked', []):
                            failures.append({'page': ident, 'profileId': pid, 'flow': flow,
                                             'errorType': 'SnapshotBlocked', 'reason': reason})
                    if any(result.get('excluded') for result in pair.values()):
                        excluded.append({'page': ident, 'profileId': pid,
                            'reasons': sorted({reason for result in pair.values() for reason in result.get('reasons', [])})})
                        private_save(args.output, report)
                        continue
                    lookup = {flow: {item['capturedId']: item for item in result['fields']}
                              for flow, result in pair.items()}
                    for captured_id in sorted(set(lookup['legacy']) | set(lookup['simple'])):
                        if not all(captured_id in lookup[flow] for flow in calls):
                            gaps.append({'page': ident, 'profileId': pid, 'fieldId': captured_id,
                                         'reason': 'flow_field_missing'})
                            continue
                        old, new = (lookup[flow][captured_id] for flow in calls)
                        if not old['comparisonEligible'] or not new['comparisonEligible']:
                            continue
                        field = normalized_field(new)
                        # Compare retained display values, not DOM IDs assigned during replay.
                        field['options'] = [{'value': option['label'], 'label': option['label']}
                                            for option in field['options']]
                        context = request_context({'jobUrl': page.get('jobIdentity', ''),
                                                   'jobCountry': next((item['request']['jobCountry'] for item in pair['simple']['requests']), '')})
                        expected = gold_for(records, field, context, version)
                        gold_source = 'recent_person_answer' if expected is not None else None
                        known = captures.get(ident)
                        if expected is None and known:
                            expected = reported_expected(field, profile)
                            if expected is not None:
                                gold_source = 'reported_failure_profile_fact'
                        results.append(dict(page=known or ident, corpusId=ident, capturedId=captured_id,
                            profileId=pid, profileVersion=version, profileName=profile['profileName'],
                            contextComplete=job['complete'], jobContext=job, field=field,
                            legacy=effective_answer(old), simple=effective_answer(new),
                            proposals={'legacy': old['answer'], 'simple': new['answer']},
                            gold=expected, goldSource=gold_source))
                    private_save(args.output, report)
                    print(json.dumps({'checked': len(results), 'providerCalls': calls,
                                      'excludedPages': len(excluded), 'captureGaps': len(gaps)}), flush=True)
    metrics = {}
    for flow in calls:
        metrics[flow] = {
            'unknown': sum(row[flow]['kind'] == 'unknown' for row in results),
            'local': sum(row[flow]['stage'] == 'local' for row in results),
            'snapshotWriteFailures': sum(row[flow].get('interruptionReason') == 'snapshot_write_failed' for row in results),
            'wrongGold': sum(row['gold'] is not None and row[flow]['value'] is not None and row[flow]['value'] != row['gold'] for row in results),
            'unansweredGold': sum(row['gold'] is not None and row[flow]['value'] is None for row in results),
            'invalidOptions': 0, 'internalValues': 0, 'chineseMissing': 0,
        }
        for result in results:
            row = result[flow]
            value = row.get('value')
            options = result['field']['options']
            if value is not None and options:
                values = value if isinstance(value, list) else [value]
                metrics[flow]['invalidOptions'] += int(any(item not in [option['label'] for option in options] for item in values))
            metrics[flow]['internalValues'] += int(not options and isinstance(value, str) and value in ENUM_TEXT and '_' in value)
            metrics[flow]['chineseMissing'] += int(row['stage'] == 'server' and (not row.get('questionZh') or not row.get('reasonZh')))
    changed = [i for i, row in enumerate(results) if (row['legacy']['kind'], row['legacy']['value']) != (row['simple']['kind'], row['simple']['value'])]
    unchanged = [i for i in range(len(results)) if i not in changed]
    report.update(summary={
        'questions': len(results), 'goldCount': sum(row['gold'] is not None for row in results),
        'metrics': metrics, 'providerCalls': calls,
        'contextIncomplete': sum(not row['contextComplete'] for row in results),
        'captureGaps': len(gaps), 'excludedPages': len({row['page'] for row in excluded}),
        'failures': len(failures)}, changed=changed,
        unchangedSample=random.Random(20261010).sample(unchanged, min(30, len(unchanged))),
        limitations=[
            'Snapshots are replayed with the selected current Profile from blank controls; original personal values and historical requests are not restored.',
            'Actual scanner, local resolver, writer ledger, pending-field preparation and formContext generation run; platform-specific adapter bindings and uploads are not replayed.',
            'Dynamic option/retention boundaries use captured recordings only. This does not verify live site acknowledgment, navigation or submission.',
            'Job context comes only from the captured posting identity in the same readonly database; missing or external postings remain incomplete.',
            'Damaged question/option inputs and snapshot semantic changes are excluded, not repaired or treated as AI failures.',
            'Model caches are never gold; unlabelled facts still require owner review.',
        ])
    private_save(args.output, report)
    source.close()
    print(json.dumps(report['summary']), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--extension', required=True, help='Matching extension source checkout with its existing dependencies')
    parser.add_argument('--node', default='node')
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--reported-only', action='store_true')
    parser.add_argument('--profile-name', choices=['Intern', 'Newgrad'])
    parser.add_argument('--reuse-legacy')
    parser.add_argument('--resume')
    asyncio.run(run(parser.parse_args()))
