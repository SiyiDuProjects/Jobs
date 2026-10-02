"""Strict, bounded input contract for the explicit installed-storage migration."""
import hashlib
import json
import math
from pathlib import Path
import re
import uuid
import time
from .request_budget import DEADLINE

CONTRACT = json.loads(Path(__file__).with_name('storage-migration-contract.json').read_text(encoding='utf-8'))
LIMITS = CONTRACT['limits']
POLICY = CONTRACT['sourcePolicy']


def checkpoint():
    deadline = DEADLINE.get()
    if deadline is not None and time.monotonic() > deadline:
        fail('migration_limit', 503)


class MigrationError(ValueError):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


def fail(code='migration_invalid_source', status=400):
    raise MigrationError(code, status)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def identifier(value):
    try:
        parsed = str(uuid.UUID(value))
        if parsed != value:
            fail()
        return parsed
    except (ValueError, TypeError, AttributeError):
        fail()


def hash_value(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        fail()
    return value


def strict_json(data, *, max_bytes=None, max_nodes=None):
    """Bound allocation before JSON decoding, then reject duplicate/nonfinite values.

    The first pass counts lexical value/key starts (a conservative node budget)
    and nesting outside strings. Escaped quotes never influence that accounting.
    Only one bounded entry is decoded at a time by callers.
    """
    if isinstance(data, str):
        try:
            raw = data.encode('utf-8')
        except UnicodeError:
            fail()
        text = data
    else:
        raw = data
        try:
            text = bytes(data).decode('utf-8')
        except (UnicodeError, TypeError):
            fail()
    if len(raw) > (max_bytes or LIMITS['maxEntryBytes']):
        fail('migration_limit', 413)
    budget = max_nodes or LIMITS['maxJsonNodes']
    depth = nodes = 0
    quoted = escape = atom = False
    for index, char in enumerate(text):
        if index % 16384 == 0: checkpoint()
        if quoted:
            if escape:
                escape = False
            elif char == '\\':
                escape = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
            nodes += 1
            atom = False
        elif char in '{[':
            depth += 1
            nodes += 1
            atom = False
        elif char in '}]':
            depth -= 1
            atom = False
        elif char.isspace() or char in ',:':
            atom = False
        elif not atom:
            nodes += 1
            atom = True
        if depth > LIMITS['maxJsonDepth'] or nodes > budget:
            fail('migration_limit', 413)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail()
            result[key] = value
        return result
    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            fail()
        return parsed
    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_float=number, parse_constant=lambda _: fail())
    except (ValueError, RecursionError, UnicodeError):
        fail()
    pending = [value]
    while pending:
        checkpoint()
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(item.keys()); pending.extend(item.values())
        elif isinstance(item, list): pending.extend(item)
        elif isinstance(item, str):
            try: item.encode('utf-8')
            except UnicodeError: fail()
    return value, nodes


def keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        fail()


def reject_credentials(value):
    pending = [value]
    forbidden = {'password', 'passwd', 'accountpassword', 'token', 'accesstoken', 'refreshtoken',
                 'profiletoken', 'apikey', 'secret', 'authorization', 'privatekey', 'cookie', 'cookies'}
    while pending:
        checkpoint()
        item = pending.pop()
        if isinstance(item, dict):
            for key, child in item.items():
                if re.sub('[^a-z0-9]', '', key.lower()) in forbidden:
                    fail('migration_credential_source')
                pending.append(child)
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str) and (re.search(r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', item)
                or re.search(r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b', item)):
            fail('migration_credential_source')


def entry_metadata(row):
    keys(row, {'entryId', 'selector', 'storageArea', 'storageKey', 'pointer', 'disposition', 'kind', 'size', 'sha256', 'containerSha256'},
         {'entryId', 'selector', 'storageArea', 'storageKey', 'disposition', 'kind', 'size', 'sha256'})
    identifier(row['entryId']); hash_value(row['sha256'])
    if type(row['size']) is not int or not 0 <= row['size'] <= LIMITS['maxEntryBytes']:
        fail('migration_limit', 413)
    key = row['storageKey']
    if not isinstance(key, str) or not isinstance(row['selector'], str):
        fail()
    pointer = row.get('pointer')
    if row['storageArea'] == 'session':
        valid = key == 'jobsManagementBaseV1' or bool(re.fullmatch(r'jobsResponses:[a-f0-9-]{36}', key))
        if not valid or pointer is not None or row['selector'] != 'session:' + key or 'containerSha256' in row:
            fail()
        if row['disposition'] != 'remove_key' or row['kind'] != ('merge_baseline' if key == 'jobsManagementBaseV1' else 'answers'):
            fail()
        if key.startswith('jobsResponses:'): identifier(key.split(':', 1)[1])
        return row
    if row['storageArea'] != 'local': fail()
    if pointer is not None:
        valid = key == 'settings' and pointer == '/premiumSettings/responseContext'
        valid |= key == 'configList' and bool(re.fullmatch(r'/(?:0|[1-9][0-9]{0,5})/premiumSettings/responseContext', pointer))
        if not valid or row['selector'] != key + '#' + pointer or row['disposition'] != 'remove_path' or row['kind'] != 'response_context':
            fail()
        hash_value(row.get('containerSha256'))
    else:
        if row['selector'] != key or 'containerSha256' in row:
            fail()
        identity = key in POLICY['identityKeys']
        if key not in POLICY['legacyKeys'] and not identity and not re.fullmatch(POLICY['legacyPattern'], key):
            fail()
        if row['disposition'] != ('retain_identity' if identity else 'remove_key'):
            fail()
        kinds = {'profile': 'profile', 'jobsProfilesCache': 'profile', 'jobsProfileBeforeMigration': 'profile_backup',
                 'jobsProfilePending': 'profile_pending', 'responseList': 'answers', 'jobsResponsesLegacyBackup': 'answers_backup',
                 'jobsManagementBaseV1': 'merge_baseline', 'jobsManagementBeforeMigrationV1': 'management_backup',
                 'jobsTabProfileRecoveryV1': 'legacy_recovery', 'appliedList': 'legacy_applications'}
        expected = 'identity' if identity else 'answers' if key.startswith('jobsResponses:') else kinds.get(key)
        if row['kind'] != expected:
            fail()
    return row


def manifest(text, digest):
    value, _ = strict_json(text, max_bytes=LIMITS['maxManifestBytes'])
    hash_value(digest)
    if sha(text.encode('utf-8')) != digest:
        fail('migration_manifest_conflict', 409)
    keys(value, {'version', 'migrationId', 'clientBuild', 'inventoryVersion', 'entries'},
         {'version', 'migrationId', 'clientBuild', 'inventoryVersion', 'entries'})
    identifier(value['migrationId'])
    if type(value['version']) is not int or value['version'] != CONTRACT['version'] or type(value['inventoryVersion']) is not int or value['inventoryVersion'] != CONTRACT['version']:
        fail()
    if not isinstance(value['clientBuild'], str) or not re.fullmatch('[A-Za-z0-9._-]{1,128}', value['clientBuild']):
        fail()
    entries = value['entries']
    if not isinstance(entries, list) or len(entries) > LIMITS['maxEntries']:
        fail('migration_limit', 413)
    for row in entries:
        entry_metadata(row)
    if len({r['entryId'] for r in entries}) != len(entries) or len({r['selector'] for r in entries}) != len(entries):
        fail()
    if sum(r['size'] for r in entries) > LIMITS['maxTotalBytes']:
        fail('migration_limit', 413)
    if [r['selector'] for r in entries] != sorted(r['selector'] for r in entries):
        fail()
    containers = {}
    for row in entries:
        if row.get('pointer'):
            if containers.setdefault(row['storageKey'], row['containerSha256']) != row['containerSha256']:
                fail()
    return value


def _application_review_snapshot(value):
    """Validate the two historical server projections; never import their state."""
    from .application_progress import STAGES, ASSESSMENT_TYPES
    if not isinstance(value, list): fail()
    common = {'job_id', 'stage', 'message_id', 'received_at', 'summary', 'reason', 'candidates'}
    candidate_fields = {'id', 'jobTitle', 'companyName', 'jobLink'}
    for row in value:
        if not isinstance(row, dict): fail()
        reason = row.get('reason')
        if not isinstance(reason, str) or reason not in {'multiple_application_records', 'application_match_pending'}: fail()
        extra = {'companyName', 'assessment_type', 'candidate_job_ids'} if reason == 'application_match_pending' else set()
        keys(row, common | extra | {'label'}, common | extra)
        if any(not isinstance(row[name], str) for name in ('job_id', 'stage', 'message_id', 'summary', 'reason')): fail()
        if row['stage'] not in {*STAGES, 'received'}: fail()
        stamp = row['received_at']
        if type(stamp) not in {int, float} or (type(stamp) is float and not math.isfinite(stamp)): fail()
        if 'label' in row and not isinstance(row['label'], str): fail()
        if not isinstance(row['candidates'], list): fail()
        for candidate in row['candidates']:
            keys(candidate, candidate_fields, candidate_fields)
            if any(not isinstance(candidate[name], str) for name in candidate_fields): fail()
        if extra:
            if not isinstance(row['companyName'], str) or not isinstance(row['assessment_type'], str) or row['assessment_type'] not in ASSESSMENT_TYPES: fail()
            if not isinstance(row['candidate_job_ids'], list) or any(not isinstance(jid, str) for jid in row['candidate_job_ids']): fail()
            if row['job_id'] != 'email:' + row['message_id']: fail()


def validate_source(key, value, *, pointer=None):
    """Validate the historical producers' structures without dropping properties."""
    from .profiles import Profiles
    from .saved_responses import RULES
    from .application_records import FIELDS
    reject_credentials(value)
    def profile(item):
        try:
            Profiles.profile(item)
        except (ValueError, TypeError):
            fail()
    def identity(item):
        keys(item, {'id', 'lastSync'}, {'id'})
        identifier(item['id'])
        if 'lastSync' in item and (not isinstance(item['lastSync'], str) or len(item['lastSync']) > 100):
            fail()
    def answers(item):
        if not isinstance(item, list):
            fail()
        for row in item:
            # Damaged known rows are preserved for explicit review, not silently normalized away.
            keys(row, RULES['fields'])
    def applications(item):
        if not isinstance(item, list):
            fail()
        for row in item:
            keys(row, {*FIELDS, 'id', 'job_id', 'version', 'progress', 'submission'})
    if pointer is not None:
        if not isinstance(value, str):
            fail()
    elif key == 'profile':
        profile(value)
    elif key == 'jobsProfilesCache':
        if not isinstance(value, dict): fail()
        for pid, record in value.items():
            identifier(pid)
            keys(record, {'id', 'profile', 'last_sync', 'schema_version'}, {'id', 'profile', 'last_sync'})
            if record['id'] != pid or not isinstance(record['last_sync'], str): fail()
            profile(record['profile'])
    elif key == 'jobsProfileBeforeMigration':
        keys(value, {'profile', 'lastSyncProfile'})
        if 'profile' in value: profile(value['profile'])
        if 'lastSyncProfile' in value: identity(value['lastSyncProfile'])
    elif key == 'jobsProfilePending':
        keys(value, {'path', 'body'}, {'path', 'body'})
        if value['path'] not in {'/api/ext/sync/profile', '/api/ext/sync/profile/list'}: fail()
        keys(value['body'], {'id', 'profile', 'expected_sync'}, {'id', 'profile'})
        identifier(value['body']['id']); profile(value['body']['profile'])
        if 'expected_sync' in value['body'] and not isinstance(value['body']['expected_sync'], str): fail()
    elif key == 'lastSyncProfile':
        identity(value)
    elif key == 'jobsProfileMigration':
        keys(value, {'id', 'previousId', 'complete'}, {'id', 'complete'})
        identifier(value['id'])
        if 'previousId' in value and not isinstance(value['previousId'], str): fail()
        if type(value['complete']) is not bool: fail()
    elif key == 'jobsResponsesMigrationV1':
        keys(value, {'owner', 'at'}, {'owner', 'at'})
        if value['owner'] != 'local-default': identifier(value['owner'])
        if type(value['at']) not in {int, float}: fail()
    elif key in {'responseList', 'jobsResponsesLegacyBackup'} or key.startswith('jobsResponses:'):
        answers(value)
    elif key == 'appliedList':
        applications(value)
    elif key in {'jobsManagementBaseV1', 'jobsManagementBeforeMigrationV1'}:
        if not isinstance(value, dict): fail()
        for name, wrapped in value.items():
            review = key == 'jobsManagementBaseV1' and name == 'applicationProgressReview'
            if not review and name not in {'appliedList', 'boardCardOrder', 'settings', 'configList', 'dailyGoal', 'jobsKindProfiles'} and not re.fullmatch(POLICY['legacyPattern'], name): fail()
            item = wrapped
            if key == 'jobsManagementBaseV1':
                keys(wrapped, {'value', 'revision'}, {'value', 'revision'})
                if type(wrapped['revision']) is not int or wrapped['revision'] < 0: fail()
                item = wrapped['value']
            if review:
                if wrapped['revision'] != 0: fail()
                # The old worker saved the whole server snapshot as its BASE.
                # Plan preserves these exact bytes; this is not an application write.
                _application_review_snapshot(item)
            elif name.startswith('jobsResponses:'): answers(item)
            elif name == 'appliedList': applications(item)
            elif name in {'settings', 'boardCardOrder', 'jobsKindProfiles'} and not isinstance(item, dict): fail()
            elif name == 'configList' and (not isinstance(item, list) or any(not isinstance(v, dict) for v in item)): fail()
            elif name == 'dailyGoal' and type(item) is not int: fail()
    elif key == 'jobsTabProfileRecoveryV1':
        if not isinstance(value, dict): fail()
        for tab, row in value.items():
            if not re.fullmatch('[0-9]{1,20}', tab): fail()
            keys(row, {'id', 'profileName', 'profile', 'selectionSource', 'timestamp', 'lastSync', 'websiteJobId', 'urls', 'at'}, {'id'})
            identifier(row['id'])
            if 'profile' in row: profile(row['profile'])
            if 'urls' in row and (not isinstance(row['urls'], list) or any(not isinstance(url, str) for url in row['urls'])): fail()
    else:
        fail()
