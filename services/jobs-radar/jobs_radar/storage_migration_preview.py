"""Bounded, private, one-conflict-at-a-time review; journal contains no values."""
import json
import secrets

from .storage_migration_contract import LIMITS, canonical, checkpoint, fail, sha
from .storage_migration_plan import _current, _load, _operations

MAX_BYTES = LIMITS['maxPreviewBytes']
MAX_ROWS = LIMITS['maxPreviewRows']
PAGE_BYTES = LIMITS['maxPreviewPageBytes']
PAGE_ROWS = LIMITS['maxPreviewPageRows']
MISSING = object()


def _values(service, mid, operation, choice):
    index = int(choice.split(':', 1)[1]) if choice.startswith('source:') else 0
    source = _load(service, mid, operation['sources'][index])
    target = choice.split(':', 1)[1] if choice.startswith('profile:') else operation.get('target')
    kind = operation['kind']
    if kind == 'answers' and choice.startswith('profile:'): target = 'jobsResponses:' + target
    current = _current(service, kind, target) if target and kind in {'profile', 'context', 'answers'} else {}
    remote = current.get('value', MISSING)
    if kind == 'context' and remote is not MISSING:
        remote = remote.get('applicationData', {}).get('aiNotes', MISSING)
    fingerprint = sha(canonical(dict(choice=choice, sources=operation['sources'], target=target,
                                     current={key: value for key, value in current.items() if key != 'value'})))
    return source, remote, fingerprint


def _attachment(value):
    if value is MISSING: return {'present': False}
    data = value.encode('utf-8') if isinstance(value, str) else canonical(value)
    return {'present': True, 'sha256': sha(data), 'size': len(data), 'encoding': 'base64-text'}


def _rows(source, current, path=()):
    checkpoint()
    if source == current: return
    label = '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in path)
    if path and str(path[-1]).lower().endswith('base64'):
        yield dict(path=label, type='attachment', source=_attachment(source), current=_attachment(current))
        return
    if isinstance(source, dict) or isinstance(current, dict):
        if (not isinstance(source, dict) and source is not MISSING) or (not isinstance(current, dict) and current is not MISSING):
            yield from _rows(source, MISSING, path)
            yield from _rows(MISSING, current, path)
            return
        local = source if isinstance(source, dict) else {}
        remote = current if isinstance(current, dict) else {}
        for key in sorted(local.keys() | remote.keys()):
            yield from _rows(local.get(key, MISSING), remote.get(key, MISSING), (*path, key))
        return
    if isinstance(source, list) or isinstance(current, list):
        if (not isinstance(source, list) and source is not MISSING) or (not isinstance(current, list) and current is not MISSING):
            yield from _rows(source, MISSING, path)
            yield from _rows(MISSING, current, path)
            return
        local = source if isinstance(source, list) else []
        remote = current if isinstance(current, list) else []
        for index in range(max(len(local), len(remote))):
            yield from _rows(local[index] if index < len(local) else MISSING, remote[index] if index < len(remote) else MISSING, (*path, index))
        return
    source_value = None if source is MISSING else source
    current_value = None if current is MISSING else current
    # Chunk individual long text fields without pretending a prefix is whole.
    parts = max((len(v) + 1023) // 1024 if isinstance(v, str) else 1 for v in (source_value, current_value))
    for part in range(max(parts, 1)):
        checkpoint()
        yield dict(path=label, type='value', sourcePresent=source is not MISSING, currentPresent=current is not MISSING,
                   source=source_value[part * 1024:(part + 1) * 1024] if isinstance(source_value, str) else source_value,
                   current=current_value[part * 1024:(part + 1) * 1024] if isinstance(current_value, str) else current_value,
                   part=part + 1, parts=max(parts, 1))


def preview(service, device, mid, conflict, choice, cursor=None):
    with service.store.connect() as c:
        session = service._session(c, device, mid)
    if session['phase'] not in {'required_input', 'ready_to_apply'}: fail('migration_required_input')
    operation = next((op for op in _operations(service, mid) if op['id'] == conflict), None)
    if not operation or not operation.get('conflict') or choice not in {c['id'] for c in operation['conflict']['choices']} or choice == 'preserve': fail('migration_required_input')
    source, current, fingerprint = _values(service, mid, operation, choice)
    rows, total = [], 0
    for row in _rows(source, current):
        total += len(canonical(row))
        if total > MAX_BYTES or len(rows) == MAX_ROWS:
            return dict(planRevision=session['revision'], conflictId=conflict, choiceId=choice, rows=[], complete=False,
                        blocked=True, code='migration_preview_limit', message='差异超出完整审阅限额，原件保持不变，请按受控人工流程处理。')
        rows.append(row)
    with service.store.connect(True) as c:
        prior = c.execute('SELECT metadata FROM installed_migration_previews WHERE migration_id=? AND operation_id=? AND choice=?', (mid, conflict, choice)).fetchone()
        state = json.loads(prior['metadata']) if prior else None
        if cursor in {None, '', '0'}:
            state = dict(revision=session['revision'], fingerprint=fingerprint, cursors={'0': 0}, completed=None)
            cursor = '0'
        if not state or state['revision'] != session['revision'] or state['fingerprint'] != fingerprint or cursor not in state['cursors']:
            fail('migration_plan_stale')
        offset = state['cursors'][cursor]
        page, size = [], 1024
        for row in rows[offset:]:
            additional = len(canonical(row)) + 1
            if len(page) >= PAGE_ROWS or size + additional > PAGE_BYTES: break
            page.append(row); size += additional
        following = offset + len(page)
        if following < len(rows) and not page: fail('migration_limit', 413)
        complete = following == len(rows)
        result = dict(planRevision=session['revision'], conflictId=conflict, choiceId=choice, rows=page, complete=complete,
                      totalRows=len(rows), totalBytes=total)
        if complete:
            state['completed'] = state['completed'] or secrets.token_urlsafe(32)
            result['previewId'] = state['completed']
        else:
            next_cursor = next((key for key, value in state['cursors'].items() if value == following), None) or secrets.token_urlsafe(24)
            state['cursors'][next_cursor] = following
            result['nextCursor'] = next_cursor
        c.execute('INSERT INTO installed_migration_previews VALUES(?,?,?,?) ON CONFLICT(migration_id,operation_id,choice) DO UPDATE SET metadata=excluded.metadata',
                  (mid, conflict, choice, canonical(state).decode()))
    return result


def verify_preview(service, device, mid, operation, revision, choice, preview_id):
    with service.store.connect() as c:
        service._session(c, device, mid)
        row = c.execute('SELECT metadata FROM installed_migration_previews WHERE migration_id=? AND operation_id=? AND choice=?', (mid, operation['id'], choice)).fetchone()
    if not row or not preview_id: fail('migration_required_input')
    state = json.loads(row['metadata'])
    if state['revision'] != revision or state['completed'] != preview_id: fail('migration_plan_stale')
    if _values(service, mid, operation, choice)[2] != state['fingerprint']: fail('migration_plan_stale')
