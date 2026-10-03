"""Bounded application diagnostics with each field's fill decision; never an execution target."""
import hashlib
import hmac
import json
import re
import secrets
import time

from .store import encoded
from .job_match import job_key

RETENTION_DAYS = 30
MAX_RUNS = 2000
MAX_BYTES = 160_000


def event_metrics(event):
    """Accept only named counters/durations and page visibility, never free text."""
    from .browser_control import shape, integer
    result = {}
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
    return item


def validate(value, now):
    from .browser_control import shape, text, integer, boolean, sequence, safe_url
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
            shape(field, ('id', 'question', 'kind', 'hasValue', 'invalid', 'required', 'status', 'attempts'), ('value', 'decision', 'trace'))
            f = {k: text(field[k], 300 if k == 'question' else 80, empty=k == 'question')
                 for k in ('id', 'question', 'kind', 'status')}
            if re.search(r'password|one.time|verification.code|security.code|验证码|密码', f['question'] + ' ' + f['kind'], re.I):
                continue
            f.update({k: boolean(field[k]) for k in ('hasValue', 'invalid', 'required')})
            f['attempts'] = integer(field['attempts'], 1_000_000)
            if 'value' in field:
                f['value'] = text(field['value'], 120, empty=True)
            # Why a field holds its value: the answer decision and the last
            # write's choice among the options the page offered.
            if 'decision' in field:
                d = shape(field['decision'], (), ('status', 'source', 'reason', 'field', 'ruleId', 'at'))
                f['decision'] = {k: integer(v, now + 60_000) if k == 'at' else text(v, 80) for k, v in d.items()}
            if 'trace' in field:
                t = shape(field['trace'], (), ('source', 'topic', 'result', 'method', 'reason', 'answer', 'chosen',
                                               'alias', 'readback', 'optionCount', 'options', 'at'))
                trace = {k: text(t[k], 40) for k in ('source', 'topic', 'result', 'method', 'reason') if k in t}
                trace.update({k: text(t[k], 120, empty=True) for k in ('answer', 'chosen', 'alias', 'readback') if k in t})
                if 'at' in t:
                    trace['at'] = integer(t['at'], now + 60_000)
                if 'optionCount' in t:
                    trace['optionCount'] = integer(t['optionCount'], 100_000)
                if 'options' in t:
                    trace['options'] = [text(o, 60, empty=True) for o in sequence(t['options'], 12)]
                f['trace'] = trace
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
        shape(event, ('at', 'document', 'type'), ('fieldId', 'phase', 'build', 'timing', 'visibility'))
        item = dict(at=integer(event['at'], now + 60_000), document=text(event['document'], 128),
                    type=text(event['type'], 80))
        for key in ('fieldId', 'phase', 'build'):
            if key in event:
                item[key] = text(event[key], 80)
        # No arbitrary detail, answer, options, HTML, command args or values.
        item.update(event_metrics(event))
        result['events'].append(item)
    if len(encoded(result).encode()) > MAX_BYTES:
        raise ValueError('History packet is too large')
    return result


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS browser_diagnostic_history(
        id TEXT PRIMARY KEY, device TEXT, url TEXT, first_seen INTEGER, last_seen INTEGER, data TEXT)''')
    c.execute('CREATE TABLE IF NOT EXISTS browser_diagnostic_pins(id TEXT PRIMARY KEY,case_ref TEXT NOT NULL)')
    c.execute('CREATE TABLE IF NOT EXISTS browser_diagnostic_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    c.execute("INSERT OR IGNORE INTO browser_diagnostic_settings VALUES('redaction_salt',?)", (secrets.token_hex(32),))


def redaction_salt(c):
    return bytes.fromhex(c.execute("SELECT value FROM browser_diagnostic_settings WHERE key='redaction_salt'").fetchone()[0])


def save(c, device, items, now=None):
    for item in items:
        item = redact(item, redaction_salt(c), device + ':' + item['runId'])
        key = hashlib.sha256(encoded([device, item['jobKey'], item['runId']]).encode()).hexdigest()[:24]
        old = c.execute('SELECT data FROM browser_diagnostic_history WHERE id=?', (key,)).fetchone()
        previous = json.loads(old['data']) if old else {'snapshots': [], 'events': []}
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
                    return encoded({k: v for k, v in event.items() if k not in ('timing', 'visibility')})
                enriched = {base(v) for v in rows if 'timing' in v or 'visibility' in v}
                rows = [v for v in rows if 'timing' in v or 'visibility' in v or base(v) not in enriched]
            item['truncated'] |= len(rows) > limit
            item[kind] = rows[-limit:]
        while len(encoded(item).encode()) > MAX_BYTES:
            item['truncated'] = True
            if len(item['snapshots']) > 1:
                item['snapshots'].pop(0)
            elif item['events']:
                item['events'].pop(0)
            else:
                break
        c.execute('INSERT OR REPLACE INTO browser_diagnostic_history VALUES(?,?,?,?,?,?)',
                  (key, device, item['url'], item['firstSeen'], item['lastSeen'], encoded(item)))
    cleanup(c, now)


def cleanup(c, now=None):
    now = int(time.time() * 1000) if now is None else now
    c.execute('''WITH ordinary AS (
        SELECT id,last_seen FROM browser_diagnostic_history
        WHERE id NOT IN (SELECT id FROM browser_diagnostic_pins)
          AND coalesce(json_array_length(json_extract(data,'$.caseRetention.unresolvedCaseIds')),0)=0
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
        from .browser_control import shape, sequence
        shape(payload, ('protocolVersion', 'history'))
        if payload['protocolVersion'] != 1:
            raise ValueError('Diagnostic transport version 1 is required')
        now = self.clock()
        items = [validate(v, now) for v in sequence(payload['history'], 10)]
        with self.store.connect(True) as c:
            save(c, device, items, now)
        return {'historyAccepted': True, 'historyEventMetrics': 1}

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
        return dict(id=row['id'], **redact(json.loads(row['data']), redaction_salt(c), row['id']), valuePolicy='synthetic_values_only',
                    coverage='partial', executable=False)
    stats = {}
    for row in c.execute('SELECT data FROM browser_diagnostic_history'):
        data = json.loads(row['data'])
        platform = stats.setdefault(data['ats'], {'runs': 0, 'aiFields': 0, 'manualFields': 0, 'failedFields': 0})
        platform['runs'] += 1
        fields = {field['id']: field for snapshot in data['snapshots'] for field in snapshot['fields']}
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
             snapshots=len(d['snapshots']), events=len(d['events']),
             truncated=d['truncated'])
        for r in c.execute('SELECT * FROM browser_diagnostic_history ORDER BY last_seen DESC, id DESC')],
        'notice': 'Redacted partial run diagnostics. Unresolved cases may be pinned. Not proof of submission and never executable.'}
