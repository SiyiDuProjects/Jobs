"""Bounded per-question event log. Page snapshots belong only to the corpus."""
import hashlib
import hmac
import json
import re
import secrets
import time

from .diagnostic_evidence import evidence, trace as validate_trace, decision as validate_decision, explain, evict_event
from .store import encoded
from .job_match import job_key

RETENTION_DAYS = 30
MAX_RUNS = 2000
MAX_BYTES = 160_000


def event_metrics(event):
    """Accept only named counters/durations and page visibility, never free text."""
    from .validation import shape, integer
    result = {}
    if 'answerUsage' in event:
        if event['type'] != 'auto_answer_batch':
            raise ValueError('Invalid answer usage event')
        usage = event['answerUsage']
        if usage == {'unavailable': True} and type(usage['unavailable']) is bool:
            result['answerUsage'] = usage
        else:
            keys = ('fieldCount', 'cacheHits', 'modelFields', 'modelCalls')
            shape(usage, keys)
            usage = {key: integer(usage[key], 2 if key == 'modelCalls' else 30) for key in keys}
            if (not usage['fieldCount'] or usage['cacheHits'] + usage['modelFields'] > usage['fieldCount']
                    or (usage['modelCalls'] == 0) != (usage['modelFields'] == 0)):
                raise ValueError('Invalid answer usage counts')
            result['answerUsage'] = usage
    if 'visibility' in event:
        if event['type'] != 'visibility_changed' or event['visibility'] not in ('hidden', 'visible'):
            raise ValueError('Invalid diagnostic visibility')
        result['visibility'] = event['visibility']
    if 'timing' not in event:
        return result
    kind = event['type']
    if kind not in ('auto_write_timing', 'auto_run_timing'):
        raise ValueError('Invalid diagnostic timing event')

    def numbers(value, keys):
        shape(value, (), keys)
        if not value:
            raise ValueError('Empty diagnostic timing')
        return {key: integer(number, 86_400_000 if key in ('ms', 'heldMs') else 1_000_000)
                for key, number in value.items()}

    if kind == 'auto_write_timing':
        result['timing'] = numbers(event['timing'], ('ms', 'heldMs', 'scans'))
        return result
    timing = shape(event['timing'], (), ('ms', 'scans', 'structuralScans', 'writes', 'profileChecks'))
    if not timing:
        raise ValueError('Empty diagnostic timing')
    scalar = {key: value for key, value in timing.items() if key not in ('writes', 'profileChecks')}
    result['timing'] = numbers(scalar, ('ms', 'scans', 'structuralScans')) if scalar else {}
    for key, fields in (('writes', ('writes', 'ms', 'heldMs', 'scans')),
                        ('profileChecks', ('count', 'fresh', 'ms', 'reused'))):
        if key in timing:
            result['timing'][key] = numbers(timing[key], fields)
    return result


def redact(item, salt, scope=''):
    """Preserve equality and option ordering using synthetic values only."""
    def synthetic(value):
        if not value:
            return ''
        if re.fullmatch(r'Synthetic value [a-f0-9]{24}', value):
            return value
        digest = hmac.new(salt, (scope + '\x00' + value).encode(), hashlib.sha256).hexdigest()[:24]
        return 'Synthetic value ' + digest
    for snapshot in item['snapshots']:
        for field in snapshot['fields']:
            if 'value' in field:
                field['value'] = synthetic(field['value'])
            trace = field.get('trace', {})
            for key in ('answer', 'chosen', 'alias', 'readback'):
                if key in trace:
                    trace[key] = synthetic(trace[key])
            if 'options' in trace:
                trace['options'] = [synthetic(v) for v in trace['options']]
    for event in item['events']:
        field = event.get('field', {})
        if 'value' in field: field['value'] = synthetic(field['value'])
        field_trace = field.get('trace', {})
        for key in ('answer', 'chosen', 'alias', 'readback'):
            if key in field_trace: field_trace[key] = synthetic(field_trace[key])
        if 'options' in field_trace: field_trace['options'] = [synthetic(v) for v in field_trace['options']]
        trace = event.get('trace', {})
        for key in ('answer', 'chosen', 'alias', 'readback'):
            if key in trace:
                trace[key] = synthetic(trace[key])
        if 'options' in trace:
            trace['options'] = [synthetic(v) for v in trace['options']]
    return item



def field_record(field, now):
    from .validation import shape, text, integer, boolean
    shape(field, ('id', 'question', 'kind', 'hasValue', 'invalid', 'required', 'status', 'attempts'), ('value', 'decision', 'trace'))
    f = {k: text(field[k], 300 if k == 'question' else 80, empty=k == 'question')
         for k in ('id', 'question', 'kind', 'status')}
    if re.search(r'password|one.time|verification.code|security.code|验证码|密码', f['question'] + ' ' + f['kind'], re.I):
        return None
    f.update({k: boolean(field[k]) for k in ('hasValue', 'invalid', 'required')})
    f['attempts'] = integer(field['attempts'], 1_000_000)
    if 'value' in field:
        f['value'] = text(field['value'], 120, empty=True)
    # Why a field holds its value: the answer decision and the last
    # write's choice among the options the page offered.
    if 'decision' in field:
        f['decision'] = validate_decision(field['decision'], now)
    if 'trace' in field:
        f['trace'] = validate_trace(field['trace'], now)
    return f


def validate(value, now):
    from .validation import shape, text, integer, boolean, sequence, safe_url
    from .public_job_url import public_job_url
    shape(value, ('schemaVersion', 'runId', 'build', 'url', 'ats', 'firstSeen', 'lastSeen', 'snapshots', 'events', 'truncated'), ('caseRetention',))
    if value['schemaVersion'] != 2:
        raise ValueError('Diagnostic schema version 2 is required')
    result = {k: integer(value[k], now + 60_000, 1) for k in ('firstSeen', 'lastSeen')}
    result.update(schemaVersion=2, runId=text(value['runId'], 128), build=text(value['build'], 80),
                  url=safe_url(public_job_url(value['url'])), jobKey=job_key(value['url']), ats=text(value['ats'], 80),
                  truncated=boolean(value['truncated']), snapshots=[], events=[])
    if 'caseRetention' in value:
        retained = shape(value['caseRetention'], ('revision', 'unresolvedCaseIds'))
        case_ids = [text(case_id, 128) for case_id in sequence(retained['unresolvedCaseIds'], 100)]
        if len(set(case_ids)) != len(case_ids) or any(not re.fullmatch(r'[A-Za-z0-9_-]+', case_id) for case_id in case_ids):
            raise ValueError('Diagnostic case IDs must be unique opaque identifiers')
        result['caseRetention'] = {'revision': integer(retained['revision'], 2**53 - 1, 1),
                                   'unresolvedCaseIds': sorted(case_ids)}
    if result['firstSeen'] > result['lastSeen']:
        raise ValueError('Invalid history timestamps')
    for snapshot in sequence(value['snapshots'], 60):
        shape(snapshot, ('at', 'document', 'phase', 'step', 'fields'), ('unrecognized',))
        item = dict(at=integer(snapshot['at'], now + 60_000, 1),
                    document=text(snapshot['document'], 128), phase=text(snapshot['phase'], 80),
                    step=text(snapshot['step'], 300, empty=True), fields=[])
        for field in sequence(snapshot['fields'], 150):
            f = field_record(field, now)
            if f is None: continue
            item['fields'].append(f)
        # Questions the extension's reader did not turn into a field: the
        # title and the region's tag/role/class outline, never field values.
        if 'unrecognized' in snapshot:
            item['unrecognized'] = []
            for entry in sequence(snapshot['unrecognized'], 20):
                shape(entry, ('question', 'reason', 'structure'))
                item['unrecognized'].append(dict(question=text(entry['question'], 200, empty=True),
                                                 reason=text(entry['reason'], 40),
                                                 structure=text(entry['structure'], 800, empty=True)))
        result['snapshots'].append(item)
    for event in sequence(value['events'], 1500):
        shape(event, ('at', 'document', 'type'), ('fieldId', 'phase', 'build', 'timing', 'visibility', 'answerUsage', 'sequence', 'evidence', 'trace', 'decision', 'field'))
        item = dict(at=integer(event['at'], now + 60_000), document=text(event['document'], 128),
                    type=text(event['type'], 80))
        for key in ('fieldId', 'phase', 'build'):
            if key in event:
                item[key] = text(event[key], 80)
        # No arbitrary detail, answer, options, HTML, command args or values.
        item.update(event_metrics(event))
        if 'sequence' in event:
            item['sequence'] = integer(event['sequence'], 2**53 - 1, 1)
        if 'evidence' in event:
            if event['type'] != 'causal_evidence':
                raise ValueError('Evidence requires a causal event')
            item['evidence'] = evidence(event['evidence'])
        if 'trace' in event:
            if event['type'] != 'fill_trace':
                raise ValueError('Trace requires a fill trace event')
            item['trace'] = validate_trace(event['trace'], now)
        if 'decision' in event:
            if event['type'] != 'answer_decision':
                raise ValueError('Decision requires an answer decision event')
            item['decision'] = validate_decision(event['decision'], now)
        if 'field' in event:
            if event['type'] != 'field_observed': raise ValueError('Field state requires an observation event')
            item['field'] = field_record(event['field'], now)
            if item['field'] is None: continue
            if item.get('fieldId') != item['field']['id']: raise ValueError('Field observation identity mismatch')
        result['events'].append(item)
    if len(encoded(result).encode()) > MAX_BYTES:
        raise ValueError('History packet is too large')
    return event_only(result)



def event_only(item):
    events = list(item.get('events', []))
    for snapshot in item.get('snapshots', []):
        for field in snapshot.get('fields', []):
            events.append({'at': snapshot['at'], 'document': snapshot['document'], 'type': 'field_observed',
                           'fieldId': field['id'], 'field': field, 'phase': snapshot['phase']})
    return {**item, 'snapshots': [], 'events': events}

def initialize(c):
    # Reuse the existing table and key names so a release rollback can still
    # read the same runs. New records contain events, never page snapshots.
    c.execute('''CREATE TABLE IF NOT EXISTS browser_diagnostic_history(
        id TEXT PRIMARY KEY, device TEXT, url TEXT, first_seen INTEGER, last_seen INTEGER, data TEXT)''')
    # Stream full archives in index order; sorting their payloads can exhaust /tmp.
    c.execute('CREATE INDEX IF NOT EXISTS browser_diagnostic_recent ON browser_diagnostic_history(last_seen DESC,id DESC)')
    c.execute('CREATE TABLE IF NOT EXISTS browser_diagnostic_pins(id TEXT PRIMARY KEY,case_ref TEXT NOT NULL)')
    c.execute('CREATE TABLE IF NOT EXISTS browser_diagnostic_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    c.execute("INSERT OR IGNORE INTO browser_diagnostic_settings VALUES('redaction_salt',?)", (secrets.token_hex(32),))


def redaction_salt(c):
    return bytes.fromhex(c.execute("SELECT value FROM browser_diagnostic_settings WHERE key='redaction_salt'").fetchone()[0])


def save(c, device, items, now=None):
    for item in items:
        item = redact(event_only(item), redaction_salt(c), device + ':' + item['runId'])
        key = hashlib.sha256(encoded([device, item['jobKey'], item['runId']]).encode()).hexdigest()[:24]
        old = c.execute('SELECT data FROM browser_diagnostic_history WHERE id=?', (key,)).fetchone()
        previous = event_only(json.loads(old['data'])) if old else {'snapshots': [], 'events': []}
        if old:
            prior_retention = previous.get('caseRetention')
            incoming_retention = item.get('caseRetention')
            if prior_retention:
                if not incoming_retention or incoming_retention['revision'] < prior_retention['revision']:
                    item['caseRetention'] = prior_retention
                elif incoming_retention['revision'] == prior_retention['revision'] and incoming_retention != prior_retention:
                    raise ValueError('Diagnostic case revision changed without advancing')
            item = {**item, 'firstSeen': min(item['firstSeen'], previous['firstSeen']),
                    'lastSeen': max(item['lastSeen'], previous['lastSeen']),
                    'truncated': item['truncated'] or previous['truncated']}
        for kind, limit in (('snapshots', 60), ('events', 1500)):
            merged = {encoded(v): v for v in previous[kind] + item[kind]}
            rows = sorted(merged.values(), key=lambda v: v['at'])
            if kind == 'events':
                # A legacy upload may precede the same event with metrics.
                # Keep the enriched event, preserving distinct measurements
                # even if two events happened within the same millisecond.
                def base(event):
                    return encoded({k: v for k, v in event.items() if k not in ('timing', 'visibility', 'answerUsage')})
                enriched = {base(v) for v in rows if any(k in v for k in ('timing', 'visibility', 'answerUsage'))}
                rows = [v for v in rows if any(k in v for k in ('timing', 'visibility', 'answerUsage')) or base(v) not in enriched]
            item['truncated'] |= len(rows) > limit
            if kind == 'events':
                while len(rows) > limit:
                    evict_event(rows)
                item[kind] = rows
            else:
                item[kind] = rows[-limit:]
        while len(encoded(item).encode()) > MAX_BYTES:
            item['truncated'] = True
            if len(item['snapshots']) > 1:
                item['snapshots'].pop(0)
            elif item['events']:
                evict_event(item['events'])
            else:
                break
        c.execute('INSERT OR REPLACE INTO browser_diagnostic_history VALUES(?,?,?,?,?,?)',
                  (key, device, item['url'], item['firstSeen'], item['lastSeen'], encoded(item)))
    cleanup(c, now)


def cleanup(c, now=None):
    now = int(time.time() * 1000) if now is None else now
    failed = "AND NOT EXISTS (SELECT 1 FROM corpus_failures f WHERE f.run_id=json_extract(data,'$.runId') AND f.resolved=0)" if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='corpus_failures'").fetchone() else ''
    c.execute(f'''WITH ordinary AS (
        SELECT id,last_seen FROM browser_diagnostic_history
        WHERE id NOT IN (SELECT id FROM browser_diagnostic_pins)
          AND coalesce(json_array_length(json_extract(data,'$.caseRetention.unresolvedCaseIds')),0)=0
          {failed}
        ) DELETE FROM browser_diagnostic_history WHERE id IN (SELECT id FROM ordinary)
        AND (last_seen<? OR id NOT IN (SELECT id FROM ordinary ORDER BY last_seen DESC,id DESC LIMIT ?))''',
        (now - RETENTION_DAYS * 86400000, MAX_RUNS))


def pin(c, history_id, case_ref=None):
    if not c.execute('SELECT 1 FROM browser_diagnostic_history WHERE id=?', (history_id,)).fetchone():
        raise ValueError('Unknown diagnostic run')
    if case_ref is None:
        c.execute('DELETE FROM browser_diagnostic_pins WHERE id=?', (history_id,))
    elif isinstance(case_ref, str) and re.fullmatch(r'notes/[\w./-]+\.md', case_ref):
        c.execute('INSERT OR REPLACE INTO browser_diagnostic_pins VALUES(?,?)', (history_id, case_ref))
    else:
        raise ValueError('A workspace diagnostic case path is required')


class Diagnostics:
    def __init__(self, store, clock=None):
        self.store, self.clock = store, clock or (lambda: int(time.time() * 1000))
        with store.connect() as c:
            initialize(c)

    def receive(self, device, payload):
        from .validation import shape, sequence
        shape(payload, ('protocolVersion', 'history'))
        if payload['protocolVersion'] != 1:
            raise ValueError('Diagnostic transport version 1 is required')
        now = self.clock()
        items = [validate(v, now) for v in sequence(payload['history'], 10)]
        with self.store.connect(True) as c:
            save(c, device, items, now)
        return {'historyAccepted': True, 'historyEventMetrics': 1, 'historyEvidence': 1, 'historyAnswerUsage': 1, 'eventLog': 1}

    def history(self, application_id=None):
        with self.store.connect(True) as c:
            cleanup(c, self.clock())
            return read(c, application_id)

    def retain(self, history_id, case_ref=None):
        with self.store.connect(True) as c:
            pin(c, history_id, case_ref)
        return {'id': history_id, 'pinned': case_ref is not None}


def read(c, application_id=None):
    if application_id is not None:
        row = c.execute('SELECT * FROM browser_diagnostic_history WHERE id=?', (application_id,)).fetchone()
        if not row:
            # A client runId is not globally unique across devices or job keys.
            # Keep the archive ID authoritative and never choose an arbitrary run.
            matches = c.execute("SELECT * FROM browser_diagnostic_history WHERE json_extract(data,'$.runId')=? LIMIT 2",
                                (application_id,)).fetchall()
            if len(matches) > 1:
                raise ValueError('Diagnostic runId is ambiguous; pass applications[].id from the history index')
            row = matches[0] if matches else None
        if not row:
            raise ValueError('Diagnostic run is unknown or its retention period ended')
        return dict(id=row['id'], **redact(event_only(json.loads(row['data'])), redaction_salt(c), row['id']), valuePolicy='synthetic_values_only',
                    coverage='partial', executable=False, **explain(json.loads(row['data'])))
    stats = {}
    for row in c.execute('SELECT data FROM browser_diagnostic_history'):
        data = json.loads(row['data'])
        platform = stats.setdefault(data['ats'], {'runs': 0, 'aiFields': 0, 'manualFields': 0, 'failedFields': 0})
        platform['runs'] += 1
        fields = {event['fieldId']: event['field'] for event in event_only(data)['events'] if 'field' in event}
        for field in fields.values():
            source = field.get('decision', {}).get('source', '')
            platform['aiFields'] += source in {'ai', 'model', 'ai-reviewed'}
            platform['manualFields'] += source in {'manual', 'remote', 'review'}
            platform['failedFields'] += bool(field['invalid'] or field['status'] in {'failed', 'validation_error', 'abstained'})
    return {'retentionDays': RETENTION_DAYS, 'capacityRuns': MAX_RUNS, 'platformStats': stats, 'applications': [
        dict(id=r['id'], url=r['url'], firstSeen=r['first_seen'], lastSeen=r['last_seen'],
             ats=(d := json.loads(r['data']))['ats'], runId=d.get('runId'), build=d.get('build'),
             jobKey=d.get('jobKey'), schemaVersion=d.get('schemaVersion', 1),
             pinned=bool(d.get('caseRetention', {}).get('unresolvedCaseIds') or c.execute('SELECT 1 FROM browser_diagnostic_pins WHERE id=?', (r['id'],)).fetchone()),
             caseRetention=d.get('caseRetention'),
             snapshots=0, events=len(event_only(d)['events']),
             truncated=d['truncated'])
        for r in c.execute('SELECT * FROM browser_diagnostic_history ORDER BY last_seen DESC, id DESC')],
        'notice': 'Redacted partial run diagnostics. Unresolved cases may be pinned. Not proof of submission and never executable.'}
