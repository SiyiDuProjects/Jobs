"""Evidence-based migration reconciliation; domain writes retain their own CAS.

The journal holds hashes, references and decisions. Personal values remain in
private bounded files and are materialized one operation at a time.
"""
import copy
import json
import time
import uuid
from contextlib import nullcontext

from .storage_migration_contract import canonical, checkpoint, fail, sha, strict_json
from .profiles import ProfileConflict


def _pointer(value, path):
    for part in path:
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def _load(service, mid, ref):
    with service.store.connect() as c:
        row = c.execute('SELECT metadata FROM installed_migration_entries WHERE migration_id=? AND id=?', (mid, ref['entryId'])).fetchone()
    if not row: fail()
    return _pointer(service.read_entry(mid, json.loads(row['metadata'])), ref['path'])


class _PlanSources:
    """One verified entry at a time, owned only by this plan request."""
    def __init__(self, service, mid, entries):
        self.service, self.mid = service, mid
        self.metadata = {entry['id']: entry['metadata'] for entry in entries}
        self.entry_id = self.value = None

    def read(self, entry_id):
        checkpoint()
        if entry_id != self.entry_id:
            # Release the previous parsed document before reading the next.
            self.entry_id = self.value = None
            self.value = self.service.read_entry(self.mid, self.metadata[entry_id])
            self.entry_id = entry_id
        return self.value

    def load(self, ref):
        return _pointer(self.read(ref['entryId']), ref['path'])


def _operations(service, mid):
    with service.store.connect() as c:
        return [json.loads(r['metadata']) for r in c.execute('SELECT metadata FROM installed_migration_operations WHERE migration_id=? ORDER BY rowid', (mid,))]


def _ordered(operations):
    return sorted(operations, key=lambda op: {'profile': 0, 'answers': 1, 'application': 1, 'preserve': 1, 'context': 2, 'server_cleanup': 3}[op['kind']])


def _save(service, mid, operation):
    with service.store.connect(True) as c:
        c.execute('INSERT INTO installed_migration_operations VALUES(?,?,?) ON CONFLICT(migration_id,id) DO UPDATE SET metadata=excluded.metadata',
                  (mid, operation['id'], canonical(operation).decode()))


def _current(service, kind, target):
    if kind in {'profile', 'context'}:
        try:
            row = service.profiles.get(target)
            return dict(version=row['last_sync'], sha256=sha(canonical(row['profile'])), value=row['profile'])
        except KeyError:
            with service.store.connect() as c:
                deleted = c.execute('SELECT deleted FROM owner_profiles WHERE id=?', (target,)).fetchone()
            return dict(version=None, sha256=None, value=None, deleted=bool(deleted))
    if kind in {'answers', 'server_cleanup'}:
        with service.store.connect() as c:
            row = c.execute('SELECT * FROM management_documents WHERE key=?', (target,)).fetchone()
        value = strict_json(row['value'])[0] if row else None
        return dict(version=row['revision'] if row else 0, sha256=sha(canonical(value)) if row else None, value=value)
    return {}


def _without_value(current):
    return {key: value for key, value in current.items() if key != 'value'}


def _desired(service, mid, operation, value):
    data = canonical(value)
    strict_json(data)
    service._write(service._path(mid, operation['id'] + '.desired'), data)
    operation['desiredHash'] = sha(data)
    operation['state'] = 'ready'
    operation.pop('conflict', None)


def _conflict(operation, kind, choices):
    choices = [{**choice, 'requiresPreview': choice['id'] != 'preserve'} for choice in choices]
    operation['state'] = 'required_input'
    operation['conflict'] = dict(id=operation['id'], kind=kind,
        entryIds=list(dict.fromkeys(r['entryId'] for r in operation['sources'])),
        title='确认旧资料的归属与保留方式', detail='原始内容已备份；选择前不会覆盖服务器或清理浏览器原件。',
        choices=choices)


def _choices(service, include_new=False):
    result = [dict(id='profile:' + p['id'], label='迁入资料：' + p['profileName']) for p in service.profiles.list()]
    if include_new: result.append(dict(id='new', label='保存为新的独立资料'))
    result.append(dict(id='preserve', label='仅保留受控原始备份，不用于填写'))
    return result


def _prepare(service, mid, operation, *, load=None, connection=None):
    """All ambiguous facts require a server-issued choice; names never bind IDs."""
    kind, target, sources = operation['kind'], operation.get('target'), operation['sources']
    if kind == 'preserve':
        operation['state'] = 'ready'
        return
    if kind == 'server_cleanup':
        operation['state'] = 'ready'
        return
    if kind == 'application':
        from .application_records import validate
        from .job_match import job_key
        value = load(sources[0]) if load else _load(service, mid, sources[0])
        try: value = validate(value)
        except (ValueError, TypeError):
            _conflict(operation, 'invalid_source', [dict(id='preserve', label='保留原始备份，暂不导入此记录')]); return
        key = job_key(value['jobLink'])
        with (nullcontext(connection) if connection is not None else service.store.connect()) as c:
            rows = c.execute('SELECT job_id,status,version,record,deleted FROM applications WHERE job_key=?', (key,)).fetchall()
            # Match jobs without a record too. Owner undo is durable audit evidence.
            jobs = {r['id'] for r in c.execute('SELECT id FROM jobs WHERE job_key=? AND id NOT IN (SELECT alias_id FROM job_aliases) LIMIT 2', (key,))} | {r['job_id'] for r in rows}
            undone = any(c.execute("SELECT 1 FROM audit WHERE job_id=? AND event='owner_submission_undo'", (jid,)).fetchone() for jid in jobs)
        operation['jobKey'] = key
        if not key or undone or rows or len(jobs) > 1:
            if any(all(record.get(k) == v for k, v in value.items())
                   for record in (json.loads(r['record']) for r in rows if r['record'])):
                operation['kind'] = 'preserve'; operation['reason'] = 'existing_application_evidence'; operation['state'] = 'ready'; return
            _conflict(operation, 'application_owner_undo' if undone else 'application_identity',
                      [dict(id='preserve', label='保留原始记录；不改变现有投递与撤销状态')]); return
        operation['expected'] = {'jobKey': key, 'absent': True}
        _conflict(operation, 'application_identity', [dict(id='import', label='导入为已尝试提交，尚未获 ATS 确认'),
                                                     dict(id='preserve', label='仅保留原始备份')])
        return
    if kind in {'context', 'answers', 'profile'} and (not target or kind == 'context'):
        _conflict(operation, 'response_context_owner' if kind == 'context' else 'answer_owner' if kind == 'answers' else 'profile_identity',
                  _choices(service, include_new=kind == 'profile'))
        return
    current = _current(service, kind, target)
    operation['expected'] = _without_value(current)
    if kind == 'answers':
        pid = target.split(':', 1)[1]
        try: service.profiles.get(pid)
        except (ValueError, KeyError):
            operation.pop('target', None); _conflict(operation, 'answer_owner', _choices(service)); return
    hashes = list(dict.fromkeys(ref['sha256'] for ref in sources))
    if kind == 'profile' and len(hashes) == 1 and current['sha256'] == hashes[0]:
        operation['verifiedTarget'] = dict(kind=kind, target=target, sha256=current['sha256'])
        operation['kind'] = 'preserve'; operation['reason'] = 'authoritative_profile_equal'; operation['state'] = 'ready'; return
    if kind == 'answers' and len(hashes) == 1 and current['sha256'] == hashes[0]:
        operation['verifiedTarget'] = dict(kind=kind, target=target, sha256=current['sha256'])
        operation['kind'] = 'preserve'; operation['reason'] = 'authoritative_answers_equal'; operation['state'] = 'ready'; return
    choices = [dict(id='preserve', label='保留服务器内容，并保留旧内容的原始备份')]
    if kind == 'profile' and current.get('deleted'):
        choices.insert(0, dict(id='new', label='另存新资料，不恢复已经删除的身份'))
    else:
        seen = set()
        for index, source in enumerate(sources):
            if source['sha256'] in seen: continue
            seen.add(source['sha256'])
            choices.insert(-1, dict(id='source:' + str(index), label='使用旧来源 ' + str(index + 1) + '（按当前版本保存）'))
    _conflict(operation, 'answer_conflict' if kind == 'answers' else 'profile_fact' if len(hashes) > 1 else 'profile_version', choices)


def _extract(service, mid, entry, evidence, *, read=None):
    meta, origin = entry['metadata'], entry['origin']
    eid = meta['entryId']; key = meta.get('storageKey', meta.get('key'))
    value = read(eid) if read else service.read_entry(mid, meta)
    candidates = []
    def add(kind, path, target=None, version=None):
        checkpoint()
        item = _pointer(value, path)
        candidates.append(dict(kind=kind, target=target, source=dict(entryId=eid, path=path,
                          sha256=sha(canonical(item)), version=version)))
    def contexts(container, path, key):
        configs = [(path, container)] if key == 'settings' else [(path + [str(i)], v) for i, v in enumerate(container)]
        for prefix, item in configs:
            if isinstance(item.get('premiumSettings'), dict) and item['premiumSettings'].get('responseContext'):
                add('context', prefix + ['premiumSettings', 'responseContext'])
    def document(name, item, path):
        if name.startswith('jobsResponses:'):
            pid = name.split(':', 1)[1]
            add('answers', path, name if pid != 'local-default' else None)
        elif name == 'appliedList':
            for i in range(len(item)): add('application', path + [str(i)])
        elif name in {'settings', 'configList'}: contexts(item, path, name)
    if origin == 'server':
        contexts(value, [], key)
        candidates.append(dict(kind='server_cleanup', target=key, source=dict(entryId=eid, path=[], sha256=sha(canonical(value))), revision=meta['revision']))
    elif meta.get('pointer'):
        if value: add('context', [])
    elif key == 'profile':
        identity = evidence.get('lastSyncProfile', {})
        add('profile', [], identity.get('id'), identity.get('lastSync'))
    elif key == 'jobsProfilesCache':
        for pid, row in value.items(): add('profile', [pid, 'profile'], pid, row.get('last_sync'))
    elif key == 'jobsProfilePending':
        add('profile', ['body', 'profile'], value['body']['id'], value['body'].get('expected_sync'))
    elif key == 'jobsProfileBeforeMigration' and 'profile' in value:
        identity = value.get('lastSyncProfile', {})
        add('profile', ['profile'], identity.get('id'), identity.get('lastSync'))
    elif key == 'jobsTabProfileRecoveryV1':
        for tab, row in value.items():
            if 'profile' in row: add('profile', [tab, 'profile'], row['id'], row.get('lastSync'))
    elif key in {'responseList', 'jobsResponsesLegacyBackup'} or key.startswith('jobsResponses:'):
        owner = key.split(':', 1)[1] if key.startswith('jobsResponses:') else evidence.get('jobsResponsesMigrationV1', {}).get('owner')
        add('answers', [], 'jobsResponses:' + owner if owner and owner != 'local-default' else None)
    elif key in {'jobsManagementBaseV1', 'jobsManagementBeforeMigrationV1'}:
        for name, wrapped in value.items():
            path = [name, 'value'] if key == 'jobsManagementBaseV1' else [name]
            # An acknowledged baseline proves what was read; it is not a new
            # personal decision and must never compete with pending answers.
            if key != 'jobsManagementBaseV1' or name in {'settings', 'configList'}:
                document(name, _pointer(value, path), path)
    elif key == 'appliedList':
        for index in range(len(value)): add('application', [str(index)])
    # Every byte, including non-domain metadata, receives a preservation entry.
    candidates.append(dict(kind='preserve', target=None, source=dict(entryId=eid, path=[], sha256=meta['sha256'])))
    return candidates


def _prepared_source(session, operation):
    return sha(canonical(dict(manifestHash=session['manifest_hash'], backupId=session['backup_id'],
        operation={key: operation.get(key) for key in ('id', 'kind', 'target', 'sources', 'sourceRevision')})))


def _reusable(previous, operation, source_hash):
    """Resume journal preparation without replacing decisions or stale CAS bases."""
    if not previous: return False
    unbound_answers = (previous.get('kind') == operation['kind'] == 'answers' and operation.get('target') and
                       previous.get('target') is None and previous.get('state') == 'required_input' and
                       previous.get('conflict', {}).get('kind') == 'answer_owner')
    if (any(previous.get(key) != operation.get(key) for key in ('id', 'sources', 'sourceRevision')) or
            previous.get('target') != operation.get('target') and not unbound_answers or
            previous.get('state') not in {'ready', 'required_input'}):
        fail('migration_source_changed')
    if previous.get('kind') != operation['kind']:
        reasons = {'application': 'existing_application_evidence', 'profile': 'authoritative_profile_equal',
                   'answers': 'authoritative_answers_equal'}
        allowed = {'explicit_preservation'}
        if operation['kind'] in reasons: allowed.add(reasons[operation['kind']])
        if (previous.get('kind') != 'preserve' or previous['state'] != 'ready' or
                previous.get('reason') not in allowed):
            fail('migration_source_changed')
    prepared = previous.get('preparationSourceHash')
    if prepared is not None and prepared != source_hash: fail('migration_source_changed')
    # Legacy interrupted plans have no preparation pin: prepare those once
    # using the bounded reader, but never undo an explicit preserve decision.
    return prepared is not None or (previous['kind'] == 'preserve' and previous.get('reason') == 'explicit_preservation')


def plan(service, device, mid):
    with service.store.connect() as c:
        session = service._session(c, device, mid)
        if not session['backup_id'] or session['phase'] == 'superseded': fail('migration_incomplete_backup')
        entries = service._entries(c, mid)
    if session['revision'] == 0:
        sources = _PlanSources(service, mid, entries)
        evidence = {}
        for entry in entries:
            checkpoint()
            key = entry['metadata'].get('storageKey')
            if key in {'lastSyncProfile', 'jobsResponsesMigrationV1'}:
                evidence[key] = sources.read(entry['id'])
        groups = {}
        for entry in entries:
            checkpoint()
            for candidate in _extract(service, mid, entry, evidence, read=sources.read):
                kind, target = candidate['kind'], candidate.get('target')
                group = (kind, target) if target and kind in {'profile', 'answers'} else (kind, candidate['source']['entryId'] + ':' + '/'.join(candidate['source']['path']))
                if group not in groups:
                    op = dict(id=str(uuid.uuid5(uuid.UUID(mid), ':'.join(group))), kind=kind, target=target, sources=[], state='pending')
                    if 'revision' in candidate: op['sourceRevision'] = candidate['revision']
                    groups[group] = op
                groups[group]['sources'].append(candidate['source'])
                if len(groups) > service.limits.get('maxOperations', 2000): fail('migration_limit', 413)
        previous = {op['id']: op for op in _operations(service, mid)}
        if set(previous) - {op['id'] for op in groups.values()}: fail('migration_source_changed')
        prepared = []
        # Keep a read connection open, without BEGIN or a retained SELECT cursor.
        # Each _save still commits independently; closing its writer is no longer
        # the last connection close that checkpoints the WAL after every row.
        with service.store.connect() as connection:
            for op in groups.values():
                checkpoint()
                source_hash = _prepared_source(session, op)
                old = previous.get(op['id'])
                if _reusable(old, op, source_hash):
                    prepared.append(old)
                    continue
                _prepare(service, mid, op, load=sources.load, connection=connection)
                op['preparationSourceHash'] = source_hash
                _save(service, mid, op)
                prepared.append(op)
        phase = 'required_input' if any(op['state'] == 'required_input' for op in prepared) else 'ready_to_apply'
        checkpoint()
        with service.store.connect(True) as c:
            c.execute('UPDATE installed_migrations SET revision=1,phase=?,updated=? WHERE id=?', (phase, time.time(), mid))
    operations = _operations(service, mid)
    session = service.status(device, mid)
    conflicts = []
    for op in operations:
        if not op.get('conflict'): continue
        conflict = dict(op['conflict'])
        conflict['preview'] = dict(targetId=op.get('target'), expected=op.get('expected'),
                                   sources=[{key: ref[key] for key in ('entryId', 'path', 'sha256', 'version') if key in ref} for ref in op['sources']])
        conflicts.append(conflict)
    return dict(migrationId=mid, manifestHash=session['manifestHash'], revision=session['planRevision'], phase=session['phase'],
                conflicts=conflicts,
                operations=[dict(id=op['id'], kind=op['kind'], entryIds=list(dict.fromkeys(s['entryId'] for s in op['sources'])),
                                 summary='原件受控保留' if op['kind'] == 'preserve' else '核对并迁入对应服务器资料', state=op['state']) for op in operations])


def _phase(service, mid):
    operations = _operations(service, mid)
    phase = 'required_input' if any(o['state'] == 'required_input' for o in operations) else 'ready_to_apply'
    with service.store.connect(True) as c:
        c.execute('UPDATE installed_migrations SET phase=?,updated=? WHERE id=?', (phase, time.time(), mid))


def _trusted_baseline(service, mid, key):
    with service.store.connect() as c:
        entries = service._entries(c, mid, 'client')
    verified = []
    for entry in entries:
        checkpoint()
        if entry['metadata']['storageKey'] != 'jobsManagementBaseV1': continue
        source = service.read_entry(mid, entry['metadata']).get(key)
        if not source: continue
        with service.store.connect() as c:
            row = c.execute('SELECT value FROM management_documents WHERE key=? AND revision=?', (key, source['revision'])).fetchone()
            if not row:
                row = c.execute('SELECT value FROM management_revisions WHERE key=? AND revision=?', (key, source['revision'])).fetchone()
        if row and sha(canonical(json.loads(row['value']))) == sha(canonical(source['value'])):
            verified.append(source['value'])
    if not verified or any(canonical(v) != canonical(verified[0]) for v in verified[1:]): return None
    return verified[0]


def _merge_answers(existing, local, baseline=None):
    from .saved_responses import normalize_list, normalize_keyword
    local = normalize_list(local)
    result = list(existing or [])
    def identity(row):
        if row.get('question'):
            return ('question', row.get('jobKey'), normalize_keyword(row['question']))
        return ('id', row['id']) if row.get('id') else ('key', row.get('jobKey'), normalize_keyword(row.get('key', '')), tuple(row.get('keywords', [])))
    # A missing local row represents a deletion only with a server-verified
    # prior revision, and never removes a concurrently changed server answer.
    if baseline is not None:
        for old in baseline:
            if any(identity(row) == identity(old) for row in local): continue
            result = [row for row in result if not (identity(row) == identity(old) and canonical(row) == canonical(old))]
    for row in local:
        matches = [i for i, old in enumerate(result) if identity(old) == identity(row)]
        if matches: result[matches[0]] = row
        else: result.append(row)
    return result


def _merge_profile(service, target, source, local, remote):
    if remote is None or not source.get('version'): return local
    try: baseline = service.profiles.at_version(target, source['version'])
    except (ValueError, KeyError): return local
    missing = object()
    def merge(base, local, remote):
        checkpoint()
        if local == base: return remote
        if remote == base or remote == local: return local
        if all(isinstance(v, dict) for v in (base, local, remote)):
            result = {}
            for key in base.keys() | local.keys() | remote.keys():
                value = merge(base.get(key, missing), local.get(key, missing), remote.get(key, missing))
                if value is not missing: result[key] = value
            return result
        # The owner explicitly selected this local source for overlapping edits.
        return local
    return merge(baseline, local, remote)


def resolve(service, device, mid, revision, conflict, choice, preview_id=None):
    with service.store.connect() as c:
        session = service._session(c, device, mid)
        if session['revision'] != revision or session['phase'] not in {'required_input', 'ready_to_apply'}: fail('migration_plan_stale')
    operation = next((o for o in _operations(service, mid) if o['id'] == conflict), None)
    if not operation or not operation.get('conflict') or choice not in {c['id'] for c in operation['conflict']['choices']}: fail('migration_required_input')
    if choice != 'preserve':
        from .storage_migration_preview import verify_preview
        verify_preview(service, device, mid, operation, revision, choice, preview_id)
    if choice == 'preserve':
        operation.update(kind='preserve', reason='explicit_preservation', state='ready')
        operation.pop('conflict', None)
        operation.pop('verifiedTarget', None)
    elif operation['kind'] == 'application':
        from .application_records import validate
        _desired(service, mid, operation, validate(_load(service, mid, operation['sources'][0])))
    elif choice.startswith('profile:') or choice == 'new':
        target = choice.split(':', 1)[1] if choice.startswith('profile:') else str(uuid.uuid5(uuid.UUID(mid), operation['id']))
        operation['target'] = 'jobsResponses:' + target if operation['kind'] == 'answers' else target
        if operation['kind'] == 'context':
            current = _current(service, 'profile', target)
            if current['value'] is None: fail('migration_required_input')
            context = _load(service, mid, operation['sources'][0])
            value = copy.deepcopy(current['value'])
            data = value.setdefault('applicationData', {})
            old = data.get('aiNotes', '')
            data['aiNotes'] = old + ('\n\n' if old and context else '') + context
            service.profiles.profile(value)
            operation['expected'] = _without_value(current)
            _desired(service, mid, operation, value)
        else:
            _prepare(service, mid, operation)
    elif choice.startswith('source:'):
        index = int(choice.split(':')[1]); operation['selectedSource'] = index
        value = _load(service, mid, operation['sources'][index])
        current = _current(service, operation['kind'], operation['target'])
        # A resolve never silently refreshes an old comparison.
        if _without_value(current) != operation['expected']:
            _prepare(service, mid, operation)
        else:
            if operation['kind'] == 'answers': value = _merge_answers(current['value'], value, _trusted_baseline(service, mid, operation['target']))
            elif operation['kind'] == 'profile': value = _merge_profile(service, operation['target'], operation['sources'][index], value, current['value'])
            _desired(service, mid, operation, value)
    _save(service, mid, operation)
    with service.store.connect(True) as c:
        c.execute('UPDATE installed_migrations SET revision=revision+1 WHERE id=?', (mid,))
    _phase(service, mid)
    return plan(service, device, mid)


def _read_desired(service, mid, operation):
    path = service._path(mid, operation['id'] + '.desired')
    with path.open('rb') as stream: raw = stream.read(service.limits['maxEntryBytes'] + 1)
    value, _ = strict_json(raw)
    if sha(raw) != operation['desiredHash']: fail('migration_source_changed')
    return value


def _apply_one(service, mid, operation):
    kind = operation['kind']
    if kind == 'preserve': return
    if kind == 'server_cleanup':
        source = operation['sources'][0]
        value = _load(service, mid, source)
        removals = {path: service.management._context_hash(context) for path, context in service.management._contexts(operation['target'], value).items()}
        current = _current(service, kind, operation['target'])
        configs = [value] if operation['target'] == 'settings' else value
        for config in configs:
            if isinstance(config.get('premiumSettings'), dict): config['premiumSettings'].pop('responseContext', None)
        desired_hash = sha(canonical(value))
        operation['desiredHash'] = desired_hash
        operation['expected'] = dict(version=operation['sourceRevision'], sha256=source['sha256'])
        if current['sha256'] == desired_hash: return
        if current['version'] != operation['sourceRevision'] or current['sha256'] != source['sha256']: raise ProfileConflict('migration_plan_stale')
        checkpoint()
        service.management.write([dict(key=operation['target'], value=value, revision=current['version'])], context_removals={operation['target']: removals}, return_snapshot=False)
        return
    value = _read_desired(service, mid, operation)
    if kind in {'profile', 'context', 'answers'}:
        current = _current(service, kind, operation['target'])
        if current['sha256'] == operation['desiredHash']: return
        if kind == 'context' and _without_value(current) != operation['expected']:
            previous = [o for o in _operations(service, mid) if o['state'] == 'done' and o['kind'] in {'profile', 'context'} and o.get('target') == operation['target']]
            # Only our own preceding acknowledged write can advance this base.
            # A concurrent owner edit is never folded into an unreviewed write.
            if any(old.get('desiredHash') == current['sha256'] and old.get('resultVersion') == current['version'] for old in previous):
                value = copy.deepcopy(current['value'])
                data = value.setdefault('applicationData', {})
                context = _load(service, mid, operation['sources'][0]); old = data.get('aiNotes', '')
                data['aiNotes'] = old + ('\n\n' if old and context else '') + context
                service.profiles.profile(value)
                operation['expected'] = _without_value(current)
                _desired(service, mid, operation, value); _save(service, mid, operation)
        if _without_value(current) != operation['expected']: raise ProfileConflict('migration_plan_stale')
        checkpoint()
        if kind in {'profile', 'context'}:
            service.profiles.save(value, profile_id=operation['target'], expected_sync=current['version'], allow_create=current['value'] is None,
                                  create_only=current['value'] is None)
        else:
            service.management.write([dict(key=operation['target'], value=value, revision=current['version'])], return_snapshot=False)
    elif kind == 'application':
        from .application_records import ApplicationRecords
        idem = 'installed-migration:' + mid + ':' + operation['id']
        def guard(c):
            checkpoint()
            matches = c.execute("SELECT 1 FROM applications WHERE job_key=? AND (record IS NOT NULL OR version>0 OR deleted=1 OR status!='not_started' OR attempted_at IS NOT NULL OR confirmed_at IS NOT NULL)", (operation['jobKey'],)).fetchone()
            jobs = {r['id'] for r in c.execute('SELECT id FROM jobs WHERE job_key=? AND id NOT IN (SELECT alias_id FROM job_aliases) LIMIT 2', (operation['jobKey'],))}
            undo = any(c.execute("SELECT 1 FROM audit WHERE job_id=? AND event='owner_submission_undo'", (jid,)).fetchone() for jid in jobs)
            if matches or undo or len(jobs) > 1: raise ProfileConflict('migration_plan_stale')
        operation['applicationIds'] = ApplicationRecords(service.store).mutate([dict(action='create', value=value)], idem, guard=guard)['changed']


def apply(service, device, mid, revision, digest):
    with service.store.connect(True) as c:
        session = service._session(c, device, mid); service._match(session, digest)
        if session['revision'] != revision: fail('migration_plan_stale')
        if session['phase'] not in {'ready_to_apply', 'applying', 'ready_to_clean', 'cleaning', 'complete'}: fail('migration_required_input')
        if session['phase'] in {'ready_to_clean', 'cleaning', 'complete'}: return service.status(device, mid)
        c.execute('UPDATE installed_migrations SET phase=\'applying\' WHERE id=?', (mid,))
    operations = _ordered(_operations(service, mid))
    # Context destinations must be saved before removing the old server field.
    for operation in operations:
        checkpoint()
        if operation['state'] == 'done': continue
        try:
            _apply_one(service, mid, operation)
        except ProfileConflict:
            _conflict(operation, 'profile_version' if operation['kind'] in {'profile', 'context'} else 'answer_conflict',
                      [] if operation['kind'] == 'server_cleanup' else [dict(id='preserve', label='保留当前服务器内容和原始备份')])
            _save(service, mid, operation)
            with service.store.connect(True) as c:
                c.execute('UPDATE installed_migrations SET phase=\'required_input\',revision=revision+1,error_code=\'migration_plan_stale\' WHERE id=?', (mid,))
            return service.status(device, mid)
        operation['state'] = 'done'
        if operation['kind'] in {'profile', 'context', 'answers', 'server_cleanup'}:
            operation['resultVersion'] = _current(service, operation['kind'], operation['target'])['version']
        _save(service, mid, operation)
    return verify(service, device, mid, digest)


def verify(service, device, mid, digest):
    with service.store.connect() as c:
        session = service._session(c, device, mid); service._match(session, digest)
        entries = service._entries(c, mid)
    if not session['backup_id']: fail('migration_restore_unverified')
    if (sha(service._path(mid, 'manifest.json').read_bytes()) != session['manifest_hash'] or
            sha(service._path(mid, 'server-manifest.json').read_bytes()) != session['server_manifest_hash']):
        fail('migration_restore_unverified')
    operations = _ordered(_operations(service, mid))
    if session['revision'] == 0 or any(o['state'] != 'done' for o in operations): fail('migration_required_input')
    covered = {ref['entryId'] for op in operations for ref in op['sources']}
    if covered != {e['id'] for e in entries}: fail('migration_required_input')
    for entry in entries:
        checkpoint()
        meta = entry['metadata']
        if service._hash_file(service._path(mid, entry['id'] + '.backup')) != (meta['size'], meta['sha256']): fail('migration_restore_unverified')
    latest = {}
    for op in operations:
        if op['kind'] in {'profile', 'context', 'answers', 'server_cleanup'}:
            latest[('profile' if op['kind'] == 'context' else op['kind'], op['target'])] = op['id']
    for op in operations:
        checkpoint()
        if op.get('verifiedTarget'):
            check = op['verifiedTarget']
            if (check['kind'], check['target']) not in latest and _current(service, check['kind'], check['target'])['sha256'] != check['sha256']:
                return _changed_after_apply(service, device, mid, op)
        if op['kind'] in {'profile', 'context', 'answers', 'server_cleanup'}:
            if latest[('profile' if op['kind'] == 'context' else op['kind'], op['target'])] != op['id']: continue
            if _current(service, op['kind'], op['target'])['sha256'] != op.get('desiredHash'):
                return _changed_after_apply(service, device, mid, op)
        elif op['kind'] == 'application':
            with service.store.connect() as c:
                for aid in op.get('applicationIds', []):
                    row = c.execute('SELECT record,status,attempted_at FROM applications WHERE application_id=?', (aid,)).fetchone()
                    if not row or sha(canonical(json.loads(row['record']))) != op['desiredHash'] or row['status'] not in {'submitted_unconfirmed', 'submitted'}:
                        return _changed_after_apply(service, device, mid, op)
    with service.store.connect() as c:
        for row in c.execute("SELECT key,value FROM management_documents WHERE key IN ('settings','configList')"):
            checkpoint()
            value, _ = strict_json(row['value'])
            configs = [value] if row['key'] == 'settings' else value
            if any(isinstance(v.get('premiumSettings'), dict) and v['premiumSettings'].get('responseContext') for v in configs):
                fail('migration_plan_stale')
    with service.store.connect(True) as c:
        if session['phase'] not in {'cleaning', 'complete'}:
            c.execute('UPDATE installed_migrations SET phase=\'ready_to_clean\',error_code=NULL,updated=? WHERE id=?', (time.time(), mid))
    return service.status(device, mid)


def _changed_after_apply(service, device, mid, operation):
    _conflict(operation, 'profile_version' if operation['kind'] in {'profile', 'context', 'preserve'} else 'answer_conflict',
              [] if operation['kind'] == 'server_cleanup' else [dict(id='preserve', label='保留现行服务器内容，并将旧来源保存在受控备份')])
    _save(service, mid, operation)
    with service.store.connect(True) as c:
        c.execute('UPDATE installed_migrations SET phase=\'required_input\',revision=revision+1,error_code=\'migration_plan_stale\' WHERE id=?', (mid,))
    return service.status(device, mid)
