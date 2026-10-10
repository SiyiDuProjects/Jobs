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
    for identity, employment, application in [
        ('citizen', dict(eligibilityUS=True, sponsorship=False, citizenships=['United States']), dict(sponsorshipNow=False, sponsorshipFuture=False, visaStatus='US citizen')),
        ('opt', dict(eligibilityUS=True, sponsorship=True, citizenships=['Canada']), dict(sponsorshipNow=False, sponsorshipFuture=True, visaStatus='F-1 OPT')),
        ('resident', dict(eligibilityUS=True, sponsorship=False, citizenships=['Canada']), dict(sponsorshipNow=False, sponsorshipFuture=False, visaStatus='Green card')),
        ('unknown', {}, {}),
    ]:
        yield identity, dict(profileName='Synthetic ' + identity, nameData={}, addressData={}, contactData={}, jobData=[],
                             educationData=[], languageData=[], resumeData={}, websiteData={}, skillsData=[],
                             employmentData=employment, applicationData=application)


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
    from jobs_radar.answer_bindings import answer
    from jobs_radar.field_answers import fields_input
    corpus = json.loads(input_path.read_text())
    fields = {question_key(field): field for page in corpus['pages'] for field in page['page']['fields']}
    latest = {(row['questionId'], row['country']): row for row in corpus.get('bindings', [])}
    cases = []
    for key, original in list(fields.items())[:limit]:
        scoped = [row for (qid, _), row in latest.items() if qid == key] or [None]
        for mapping in scoped:
            field = {k: original[k] for k in ('question', 'description', 'type', 'required', 'options')}
            field['fieldId'] = key
            try:
                fields_input(dict(fields=[field]))
                supported = True
            except ValueError:
                supported = False
            cases.append((key, field, mapping, supported))
    results, violations, calls = [], [], 0
    with tempfile.TemporaryDirectory(prefix='jobs-corpus-synthetic-') as directory:
        store = Store(Path(directory) / 'synthetic.sqlite')
        service = Answers(store)
        for identity, profile in identities():
            record = Profiles(store).save(profile)
            pending = {}

            def record_result(key, field, mapping, row, route):
                row = row or {}
                results.append(dict(questionId=key, identity=identity, country=mapping['country'] if mapping else '',
                                    route=route, decision=row.get('decision', 'ask'), value=row.get('value'),
                                    reviewOnly=row.get('reviewOnly', False)))
                violations.extend(invariants(key, identity, field, row, profile))

            for key, field, mapping, supported in cases:
                row = answer(mapping['binding'], mapping['meaning'], field, profile, record['id'], record['last_sync']) if mapping else None
                if row is not None or not live or not supported:
                    record_result(key, field, mapping, row, 'cached_binding' if row else 'unmapped' if supported else 'unsupported_control')
                else:
                    pending.setdefault(mapping['country'] if mapping else '', []).append((key, field, mapping))
            for country, items in pending.items():
                for start in range(0, len(items), 10):
                    batch = items[start:start + 10]
                    try:
                        response = await service.generate(dict(profileId=record['id'], profileVersion=record['last_sync'],
                                                               fields=[field for _, field, _ in batch], jobCountry=country), client)
                        calls += response['answerUsage']['modelCalls']
                        by_id = {row['fieldId']: row for row in response['answers']}
                        for key, field, mapping in batch:
                            record_result(key, field, mapping, by_id[key], 'provider')
                    except ValueError as error:
                        calls += getattr(error, 'answer_usage', {}).get('modelCalls', 0)
                        for key, field, mapping in batch:
                            record_result(key, field, mapping, None, 'provider_unavailable')
        generated = QuestionCorpus(store).export()['bindings']
    summary = dict(questions=min(len(fields), limit), scopedCases=len(cases), identities=4, providerCalls=calls,
                   unanswered=sum(row['value'] is None for row in results), automatic=sum(row['decision'] == 'write' for row in results),
                   drafts=sum(row['decision'] == 'draft' for row in results), violations=len(violations),
                   providerUnavailable=sum(row['route'] == 'provider_unavailable' for row in results))
    save(output, dict(version=1, source=corpus.get('source'), syntheticFactsOnly=True, live=live, summary=summary,
                      results=results, violations=violations, limitations=['Proper-name checks flag suspicious tokens, not semantic truth. Prose and grounding still need human sampling.']))
    if live:
        save(output.with_suffix('.corpus.json'), {**corpus, 'bindings': [*corpus.get('bindings', []), *generated]})
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
