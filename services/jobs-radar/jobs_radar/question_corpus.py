"""Private, compressed form snapshots and independently labelled regression cases.

No Profile answers are stored here. Search observations are private owner data;
exports use the same authenticated boundary as Profiles and stay out of Git.
"""
import hashlib
import json
import re
import time
import zlib

from .public_job_url import public_job_url

TAGS = set('form div span p section fieldset legend label input textarea select option optgroup button a ul ol li table tbody tr td th h1 h2 h3 h4 article main output'.split())
ATTRS = set('id for name role type required disabled multiple hidden inert readonly aria-labelledby aria-describedby aria-controls aria-owns aria-required aria-disabled aria-hidden aria-haspopup aria-multiselectable aria-label placeholder title data-automation-id data-uxi-widget-type data-uxi-multiselect-id data-uxi-popup-anchor data-associated-widget data-option icimsdropdown-enabled icimsdropdown-search i_required class data-jobs-corpus-field value'.split())


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def question_key(field):
    return digest({key: field.get(key, '') for key in ('question', 'description', 'type', 'required')} |
                  {'options': [option['label'] for option in field.get('options', [])]})


INPUT_ISSUES = {'redacted_question', 'redacted_description', 'redacted_options', 'redacted_search_results'}


def comparison_issues(page):
    """Flag damaged benchmark input, including snapshots captured before v2.

    Identity redaction in unrelated DOM text is expected. A marker in a prompt,
    choice or search recording means the input itself is lost, not an AI error.
    """
    marker = re.compile(r'\[(?:private|email|attachment|token)\]', re.I)
    issues = set()
    for field in page.get('fields', []):
        for name in ('question', 'description'):
            if marker.search(field.get(name, '')): issues.add('redacted_' + name)
        if any(marker.search(option['label']) for option in field.get('options', [])):
            issues.add('redacted_options')
        if any(marker.search(observation['query']) or any(marker.search(value) for value in observation['options'])
               for observation in field.get('observations', [])):
            issues.add('redacted_search_results')
    return sorted(issues)


def quality(page):
    reasons = comparison_issues(page)
    return {'excluded': bool(reasons), 'reasons': reasons}


def checked_job_identity(value):
    if not isinstance(value, str) or len(value) > 3000 or value and public_job_url(value) != value:
        raise ValueError('Invalid corpus job identity')
    return value


def validate(page):
    if not isinstance(page, dict) or page.get('version') != 1 or len(encoded(page)) > 2000000:
        raise ValueError('Invalid corpus page')
    if set(page) - {'version', 'platform', 'build', 'company', 'step', 'trees', 'fields', 'coverage', 'jobIdentity', 'redactionVersion', 'quality'}:
        raise ValueError('Invalid corpus metadata')
    if not isinstance(page.get('trees'), list) or not page['trees'] or not isinstance(page.get('fields'), list) or not 0 <= len(page['fields']) <= 300:
        raise ValueError('Invalid corpus fields')
    for key in ('platform', 'build', 'company', 'step'):
        if not isinstance(page.get(key), str) or len(page[key]) > 200: raise ValueError('Invalid corpus context')
    checked_job_identity(page.get('jobIdentity', ''))
    if 'redactionVersion' in page and (type(page['redactionVersion']) is not int or page['redactionVersion'] != 2):
        raise ValueError('Invalid corpus redaction version')
    if 'quality' in page:
        supplied = page['quality']
        if (not isinstance(supplied, dict) or set(supplied) != {'excluded', 'reasons'} or
                type(supplied['excluded']) is not bool or not isinstance(supplied['reasons'], list) or
                any(not isinstance(reason, str) or reason not in INPUT_ISSUES for reason in supplied['reasons'])):
            raise ValueError('Invalid corpus quality')
    count = 0

    def tree(node, depth=0):
        nonlocal count
        count += 1
        if not isinstance(node, dict) or count > 12000 or depth > 41: raise ValueError('Invalid corpus tree')
        if 'text' in node:
            if set(node) != {'text'} or not isinstance(node['text'], str) or len(node['text']) > 20000: raise ValueError('Invalid corpus text')
            return
        tag = node.get('tag', '')
        if not isinstance(tag, str) or (tag not in TAGS and not re.fullmatch(r'[a-z][a-z0-9]*-[a-z0-9-]{1,70}', tag)): raise ValueError('Unsafe corpus tag')
        if set(node) - {'tag', 'attrs', 'children', 'shadow', 'hidden'} or not isinstance(node.get('attrs'), dict): raise ValueError('Unsafe corpus node')
        for key, value in node['attrs'].items():
            if key not in ATTRS or not isinstance(value, str) or len(value) > 1200: raise ValueError('Unsafe corpus attribute')
            if key == 'value' and (tag != 'option' or value and not re.fullmatch(r'option-\d+', value)): raise ValueError('Personal corpus value')
        if node['attrs'].get('type') == 'password': raise ValueError('Credential control')
        for key in ('children', 'shadow'):
            if not isinstance(node.get(key, []), list): raise ValueError('Invalid corpus children')
            for child in node.get(key, []): tree(child, depth + 1)
    for root in page['trees']: tree(root)
    ids = set()
    for field in page['fields']:
        if not isinstance(field, dict) or set(field) - {'id', 'question', 'description', 'type', 'required', 'options', 'observations'}: raise ValueError('Invalid corpus field')
        if not isinstance(field.get('id'), str) or not re.fullmatch(r'field-\d{1,3}', field['id']) or field['id'] in ids: raise ValueError('Invalid corpus identity')
        ids.add(field['id'])
        for key, limit in [('question', 2000), ('description', 20000), ('type', 50)]:
            if not isinstance(field.get(key), str) or len(field[key]) > limit: raise ValueError('Invalid corpus question')
        if type(field.get('required')) is not bool or not isinstance(field.get('options'), list) or len(field['options']) > 1000: raise ValueError('Invalid corpus choices')
        for option in field['options']:
            if not isinstance(option, dict) or set(option) != {'label', 'value'} or not isinstance(option['value'], str) or not re.fullmatch(r'option-\d+', option['value']) or not isinstance(option['label'], str) or len(option['label']) > 500: raise ValueError('Invalid corpus option')
        if not isinstance(field.get('observations'), list) or len(field['observations']) > 20: raise ValueError('Invalid corpus searches')
        for search in field['observations']:
            if not isinstance(search, dict) or set(search) != {'query', 'options'} or not isinstance(search['query'], str) or len(search['query']) > 500 or not isinstance(search['options'], list) or len(search['options']) > 1000 or any(not isinstance(v, str) or len(v) > 500 for v in search['options']): raise ValueError('Invalid corpus search')
    return page


def structures(page):
    def skeleton(node):
        if 'text' in node: return None
        return [node['tag'], {k: v for k, v in node['attrs'].items() if k in {'role', 'type', 'data-automation-id', 'data-uxi-widget-type', 'multiple', 'required'}},
                [shape for child in node['children'] + node.get('shadow', []) if (shape := skeleton(child)) is not None]]
    return [digest(skeleton(root)) for root in page['trees']]


class QuestionCorpus:
    def __init__(self, store):
        self.store = store
        with store.connect(True) as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS corpus_pages(id TEXT PRIMARY KEY,payload BLOB NOT NULL,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS corpus_seen(fingerprint TEXT PRIMARY KEY,page_id TEXT,visits INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS corpus_questions(id TEXT PRIMARY KEY,field TEXT NOT NULL,appearances INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS corpus_structures(id TEXT PRIMARY KEY,page_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS corpus_occurrences(question_id TEXT,company TEXT,visits INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(question_id,company));
                CREATE TABLE IF NOT EXISTS corpus_labels(question_id TEXT PRIMARY KEY,mapping TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS corpus_corrections(id TEXT PRIMARY KEY,question_id TEXT NOT NULL,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS corpus_page_fields(fingerprint TEXT,field_id TEXT,question_id TEXT,PRIMARY KEY(fingerprint,field_id));
                CREATE TABLE IF NOT EXISTS corpus_bindings(question_id TEXT,country TEXT,model TEXT,cache_key TEXT,updated REAL,PRIMARY KEY(question_id,country,model));
                CREATE TABLE IF NOT EXISTS corpus_searches(id TEXT PRIMARY KEY,page_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS corpus_failures(id TEXT PRIMARY KEY,page_id TEXT NOT NULL,run_id TEXT NOT NULL,document_id TEXT NOT NULL,field_ids TEXT NOT NULL,reason TEXT NOT NULL,created REAL NOT NULL,resolved INTEGER NOT NULL DEFAULT 0);
            ''')

    def probe(self, fingerprint, company='', job_identity=''):
        if not isinstance(fingerprint, str) or not re.fullmatch('[a-f0-9]{64}', fingerprint): raise ValueError('Invalid corpus fingerprint')
        checked_job_identity(job_identity)
        with self.store.connect(True) as c:
            known = c.execute('SELECT page_id FROM corpus_seen WHERE fingerprint=?', (fingerprint,)).fetchone()
            if known:
                # A later visit can supply the missing public identity without
                # uploading the same tree again. Never replace an existing link
                # with a different posting's otherwise identical form.
                if job_identity and known['page_id']:
                    row = c.execute('SELECT payload FROM corpus_pages WHERE id=?', (known['page_id'],)).fetchone()
                    if row:
                        page = json.loads(zlib.decompress(row['payload']))
                        if not page.get('jobIdentity'):
                            page['jobIdentity'] = job_identity
                            c.execute('UPDATE corpus_pages SET payload=? WHERE id=?',
                                      (zlib.compress(encoded(page), 9), known['page_id']))
                c.execute('UPDATE corpus_seen SET visits=visits+1 WHERE fingerprint=?', (fingerprint,))
                for row in c.execute('SELECT DISTINCT question_id FROM corpus_page_fields WHERE fingerprint=?', (fingerprint,)).fetchall():
                    c.execute('UPDATE corpus_questions SET appearances=appearances+1 WHERE id=?', (row[0],))
                    c.execute('INSERT INTO corpus_occurrences(question_id,company) VALUES(?,?) ON CONFLICT(question_id,company) DO UPDATE SET visits=visits+1', (row[0], str(company)[:200]))
            return {'known': bool(known)}

    def capture(self, fingerprint, page, failure=None):
        validate(page)
        if fingerprint != digest({k: page[k] for k in ('trees', 'fields')}): raise ValueError('Corpus fingerprint mismatch')
        if failure is not None:
            from .validation import shape, text, sequence
            shape(failure, ('runId', 'documentId', 'fieldIds', 'reason'), ('fieldLinks', 'outcomes', 'observedAt'))
            field_ids = sorted(set(text(key, 20) for key in sequence(failure['fieldIds'], 300)))
            links = failure.get('fieldLinks', {})
            if not isinstance(links, dict) or set(links) - set(field_ids) or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,80}', v) for v in links.values()):
                raise ValueError('Invalid corpus event field links')
            outcomes = failure.get('outcomes')
            if outcomes is not None:
                from .field_outcome import outcome
                from .validation import integer
                if not isinstance(outcomes, dict) or set(outcomes) - set(field_ids) or 'observedAt' not in failure:
                    raise ValueError('Invalid corpus field outcomes')
                outcomes = {key: outcome(value) for key, value in sorted(outcomes.items())}
                observed = integer(failure['observedAt'], int(time.time() * 1000) + 60_000, 1)
            failure = {**{key: text(failure[key], 128) for key in ('runId', 'documentId')},
                       'fieldIds': field_ids,
                       'reason': text(failure['reason'], 40), 'fieldLinks': links,
                       **({'outcomes': outcomes, 'observedAt': observed} if outcomes is not None else {})}
            if failure['reason'] not in {'incomplete', 'site_error', 'unrecognized_control', 'manual_report'}:
                raise ValueError('Invalid corpus failure reason')
            if set(failure['fieldIds']) - {field['id'] for field in page['fields']}:
                raise ValueError('Unknown failed corpus field')
        questions = {question_key(field): field for field in page['fields']}
        shapes = structures(page)
        with self.store.connect(True) as c:
            known = c.execute('SELECT 1 FROM corpus_seen WHERE fingerprint=?', (fingerprint,)).fetchone()
            if known and failure is None: return {'stored': False}
            novel = any(not c.execute('SELECT 1 FROM corpus_questions WHERE id=?', (key,)).fetchone() for key in questions)
            novel = novel or any(not c.execute('SELECT 1 FROM corpus_structures WHERE id=?', (key,)).fetchone() for key in shapes)
            # New recorded searches also carry reproducible behavior even when
            # the public question and DOM skeleton already exist.
            searches = {digest([question_key(field), observation]) for field in page['fields'] for observation in field['observations']}
            stored = bool(failure) or novel or any(not c.execute('SELECT 1 FROM corpus_searches WHERE id=?', (key,)).fetchone() for key in searches)
            if stored:
                stored_page = dict(page, quality=quality(page))
                stored = c.execute('INSERT OR IGNORE INTO corpus_pages VALUES(?,?,?)', (fingerprint, zlib.compress(encoded(stored_page), 9), time.time())).rowcount == 1
            if failure and 'outcomes' in failure:
                # One outcome per page of a run. A later observed state of the
                # same page replaces it; a delayed retry of an older one does not.
                ident = digest(['outcome', failure['runId'], failure['documentId']])
                c.execute('''INSERT INTO corpus_failures(id,page_id,run_id,document_id,field_ids,reason,created) VALUES(?,?,?,?,?,?,?)
                             ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,field_ids=excluded.field_ids,reason=excluded.reason
                             WHERE json_extract(excluded.field_ids,'$.observedAt')>=coalesce(json_extract(corpus_failures.field_ids,'$.observedAt'),0)''',
                          (ident, fingerprint, failure['runId'], failure['documentId'],
                           encoded({'ids': failure['fieldIds'], 'links': links, 'outcomes': failure['outcomes'],
                                    'observedAt': failure['observedAt']}).decode(),
                           failure['reason'], time.time()))
            elif failure:
                ident = digest([fingerprint, failure])
                c.execute('INSERT OR IGNORE INTO corpus_failures(id,page_id,run_id,document_id,field_ids,reason,created) VALUES(?,?,?,?,?,?,?)',
                          (ident, fingerprint, failure['runId'], failure['documentId'], encoded({'ids': failure['fieldIds'], 'links': links}).decode(), failure['reason'], time.time()))
            if known:
                c.execute('UPDATE corpus_seen SET page_id=? WHERE fingerprint=?', (fingerprint, fingerprint))
                return {'stored': stored, 'pageId': fingerprint, 'failureId': ident}
            c.execute('INSERT INTO corpus_seen(fingerprint,page_id) VALUES(?,?)', (fingerprint, fingerprint if stored else None))
            for key, field in questions.items():
                public = {k: v for k, v in field.items() if k not in {'id', 'observations'}}
                c.execute('INSERT INTO corpus_questions(id,field,appearances) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET appearances=appearances+1', (key, encoded(public).decode()))
                c.execute('INSERT INTO corpus_occurrences(question_id,company) VALUES(?,?) ON CONFLICT(question_id,company) DO UPDATE SET visits=visits+1', (key, page['company']))
            for field in page['fields']:
                c.execute('INSERT INTO corpus_page_fields VALUES(?,?,?)', (fingerprint, field['id'], question_key(field)))
            for key in shapes: c.execute('INSERT OR IGNORE INTO corpus_structures VALUES(?,?)', (key, fingerprint))
            for key in searches: c.execute('INSERT OR IGNORE INTO corpus_searches VALUES(?,?)', (key, fingerprint))
        return {'stored': stored, **({'pageId': fingerprint, 'failureId': ident} if failure else {})}

    def failures(self):
        with self.store.connect() as c:
            return [dict(id=r['id'], pageId=r['page_id'], runId=r['run_id'], documentId=r['document_id'],
                         fieldIds=fields['ids'] if isinstance(fields, dict) else fields,
                         fieldLinks=fields.get('links', {}) if isinstance(fields, dict) else {},
                         **({'outcomes': fields['outcomes']} if isinstance(fields, dict) and 'outcomes' in fields else {}),
                         reason=r['reason'], at=int(r['created'] * 1000), resolved=bool(r['resolved']))
                    for r in c.execute('SELECT * FROM corpus_failures ORDER BY created DESC,id')
                    for fields in [json.loads(r['field_ids'])]]

    def outcomes(self, run_id=None, limit=20):
        """Recent page outcomes: each field the plugin did not complete itself, who
        completed it and why it was left, with the redacted question structure."""
        from .validation import text
        if run_id is not None:
            text(run_id, 128)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('limit must be 1-100')
        query = ("SELECT f.*,p.payload FROM corpus_failures f JOIN corpus_pages p ON p.id=f.page_id "
                 "WHERE json_extract(f.field_ids,'$.outcomes') IS NOT NULL" + (' AND f.run_id=?' if run_id else '') +
                 ' ORDER BY f.created DESC,f.id LIMIT ?')
        pages, summary = [], {}
        with self.store.connect() as c:
            for r in c.execute(query, (run_id, limit) if run_id else (limit,)):
                page, record = json.loads(zlib.decompress(r['payload'])), json.loads(r['field_ids'])
                fields = {field['id']: field for field in page['fields']}
                items = []
                for ident, result in record['outcomes'].items():
                    field = fields.get(ident, {})
                    items.append({'field': ident, 'question': field.get('question', ''), 'type': field.get('type', ''),
                                  'required': bool(field.get('required')), 'options': len(field.get('options') or []), **result})
                    key = (page.get('platform', ''), field.get('type', ''), result.get('by', ''), result.get('reason', ''))
                    summary[key] = summary.get(key, 0) + 1
                pages.append({'id': r['id'], 'runId': r['run_id'], 'documentId': r['document_id'],
                              'platform': page.get('platform', ''), 'company': page.get('company', ''),
                              'jobIdentity': page.get('jobIdentity', ''), 'step': page.get('step', ''),
                              'build': page.get('build', ''), 'at': int(r['created'] * 1000), 'reason': r['reason'],
                              'resolved': bool(r['resolved']), 'fields': items})
        return {'pages': pages,
                'summary': [dict(platform=k[0], type=k[1], by=k[2], reason=k[3], count=n)
                            for k, n in sorted(summary.items(), key=lambda item: (-item[1], item[0]))],
                'notice': 'One entry per page of a run, updated until the page ended. Fields list only what the plugin '
                          'did not complete itself. Redacted structure, no answer values; summary covers the returned pages only.'}

    def resolve_failure(self, ident, resolved):
        if type(resolved) is not bool: raise ValueError('Invalid corpus resolution')
        with self.store.connect(True) as c:
            if c.execute('UPDATE corpus_failures SET resolved=? WHERE id=?', (int(resolved), ident)).rowcount != 1:
                raise ValueError('Unknown corpus failure')
        return {'ok': True}

    def failure_page(self, ident):
        with self.store.connect() as c:
            row = c.execute('SELECT p.id,p.payload FROM corpus_failures f JOIN corpus_pages p ON p.id=f.page_id WHERE f.id=?', (ident,)).fetchone()
            if not row: raise ValueError('Unknown corpus failure')
            return {'id': row['id'], 'page': json.loads(zlib.decompress(row['payload'])),
                    'failures': [item for item in self.failures() if item['pageId'] == row['id']]}

    def correction(self, fingerprint, field_id, ident):
        if not isinstance(ident, str) or not re.fullmatch('[a-f0-9-]{36}', ident): raise ValueError('Invalid correction ID')
        with self.store.connect(True) as c:
            row = c.execute('SELECT question_id FROM corpus_page_fields WHERE fingerprint=? AND field_id=?', (fingerprint, field_id)).fetchone()
            if not row: raise ValueError('Unknown corpus question')
            c.execute('INSERT OR IGNORE INTO corpus_corrections VALUES(?,?,?)', (ident, row[0], time.time()))
        return {'recorded': True, 'gold': False}

    def label(self, question_id, mapping):
        """Explicit independent annotation, never inferred from a changed answer."""
        from .answer_bindings import checked
        with self.store.connect(True) as c:
            row = c.execute('SELECT field FROM corpus_questions WHERE id=?', (question_id,)).fetchone()
            if not row or not isinstance(mapping, dict) or set(mapping) != {'binding', 'meaning'}:
                raise ValueError('Unknown question or invalid annotation')
            if not checked(mapping['binding'], mapping['meaning'], json.loads(row[0])):
                raise ValueError('Invalid annotated mapping')
            c.execute('INSERT OR REPLACE INTO corpus_labels VALUES(?,?,1,?)', (question_id, encoded(mapping).decode(), time.time()))

    @staticmethod
    def link_binding(c, field, context, model, key):
        c.execute('INSERT OR REPLACE INTO corpus_bindings VALUES(?,?,?,?,?)', (question_key(field), context.get('jobContext', {}).get('country', ''), model, key, time.time()))

    def export(self, offset=0, limit=20):
        if type(offset) is not int or offset < 0 or not 1 <= limit <= 50: raise ValueError('Invalid corpus page')
        with self.store.connect() as c:
            rows = c.execute('SELECT id,payload FROM corpus_pages ORDER BY created,id LIMIT ? OFFSET ?', (limit + 1, offset)).fetchall()
            labels = {r['question_id']: json.loads(r['mapping']) for r in c.execute('SELECT * FROM corpus_labels WHERE confirmed=1')}
            bindings = []
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='answer_bindings'").fetchone():
                bindings = [dict(questionId=r['question_id'], country=r['country'], model=r['model'], updated=r['updated'], **json.loads(r['binding']))
                            for r in c.execute('SELECT b.*,a.binding FROM corpus_bindings b JOIN answer_bindings a ON a.key=b.cache_key ORDER BY b.updated')]
            corrections = [dict(questionId=r[0], count=r[1]) for r in c.execute('SELECT question_id,COUNT(*) FROM corpus_corrections GROUP BY question_id')]
            pages = []
            for row in rows[:limit]:
                page = json.loads(zlib.decompress(row['payload']))
                page['quality'] = quality(page)
                pages.append({'id': row['id'], 'page': page})
            return {'pages': pages, 'failures': self.failures(),
                    'labels': labels, 'bindings': bindings, 'corrections': corrections, 'next': offset + limit if len(rows) > limit else None}


def register_corpus_routes(api, store, authorize):
    corpus = QuestionCorpus(store)

    @api.route('/api/extension/corpus', ['GET', 'POST'], authorize, max_bytes=2100000)
    async def exchange(request, payload, principal):
        if request.method == 'GET': return corpus.export(int(request.query_params.get('offset', 0)))
        if payload.get('action') == 'probe': return corpus.probe(payload.get('fingerprint'), payload.get('company', ''), payload.get('jobIdentity', ''))
        if payload.get('action') == 'capture': return corpus.capture(payload.get('fingerprint'), payload.get('page'), payload.get('failure'))
        if payload.get('action') == 'correction': return corpus.correction(payload.get('fingerprint'), payload.get('fieldId'), payload.get('id'))
        if payload.get('action') == 'failures': return corpus.failures()
        if payload.get('action') == 'failure-page': return corpus.failure_page(payload.get('id'))
        if payload.get('action') == 'resolve-failure': return corpus.resolve_failure(payload.get('id'), payload.get('resolved'))
        raise ValueError('Invalid corpus action')
