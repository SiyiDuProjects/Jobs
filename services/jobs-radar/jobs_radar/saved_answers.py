"""Profile-scoped exact reuse and labelled retrieval of historical answers."""
import json
import re
from datetime import datetime, timezone
from .answer_cache import digest
from .answer_memory import normalized, company_key, request_context as request_context

STOP = {'a','an','the','to','of','in','at','for','is','are','do','does','you','your','and','or','this','that'}

def timestamp(value):
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return stamp.timestamp() if stamp.tzinfo else None
    except (ValueError, TypeError, AttributeError): return None

def tokens(text):
    return set(re.findall(r'\w+', normalized(text))) - STOP


class SavedAnswers:
    def __init__(self, store, pid, version, context):
        self.store, self.key, self.context = store, 'jobsResponses:' + pid, context
        self.profile_time = timestamp(version)
        self.revision, self.rows = self.read()

    def read(self):
        with self.store.connect() as c:
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='management_documents'").fetchone(): return 0, []
            row = c.execute('SELECT value,revision FROM management_documents WHERE key=?', (self.key,)).fetchone()
        return (row['revision'], json.loads(row['value'])) if row else (0, [])

    def fingerprint(self, field):
        return digest([self.candidates(field), self.exact(field)])

    def current(self, field):
        revision, rows = self.read()
        if revision == self.revision: return True
        snapshot = self.rows
        before = self.fingerprint(field)
        try:
            self.rows = rows
            return self.fingerprint(field) == before
        finally:
            self.rows = snapshot

    def candidates(self, field):
        query, found = tokens(field['question']), []
        for row in self.rows:
            if not isinstance(row, dict) or not isinstance(row.get('response'), str) or not row['response'].strip(): continue
            question = row.get('question') or row.get('key', '')
            if not isinstance(question, str): continue
            words = tokens(question); union = query | words
            score = len(query & words) / len(union) if union else 0
            if score < .35: continue
            context = row.get('context') if isinstance(row.get('context'), dict) else {}
            found.append((score, timestamp(context.get('capturedAt')) or 0, {
                'question': question, 'answer': row['response'],
                'company': company_key(row.get('jobKey') or context.get('jobKey', '')) or 'Unknown',
                'country': context.get('country', ''), 'date': context.get('capturedAt', 'Unknown'),
                'origin': row.get('origin', 'legacy'), 'scope':row.get('scope','unknown'),
                'jobKey':row.get('jobKey') or context.get('jobKey',''),
            }))
        return [item for _, _, item in sorted(found, key=lambda item: item[:2], reverse=True)[:5]]

    def exact(self, field):
        matches = []
        for row in self.rows:
            if not isinstance(row, dict) or row.get('origin') != 'person': continue
            if not isinstance(row.get('question'), str) or normalized(row['question']) != normalized(field['question']): continue
            context = row.get('context') if isinstance(row.get('context'), dict) else {}; captured = timestamp(context.get('capturedAt'))
            if not captured or not self.profile_time or captured <= self.profile_time or captured > datetime.now(timezone.utc).timestamp() + 300: continue
            company = company_key(row.get('jobKey') or context.get('jobKey', ''))
            if not company or company != self.context['companyKey'] or context.get('country', '') != self.context['country']: continue
            if row.get('scope') == 'job' and (row.get('jobKey') or context.get('jobKey')) != self.context['jobKey']: continue
            options = field['options']; value = row.get('response')
            if options:
                captured_options = row.get('options')
                if not isinstance(captured_options, list): continue
                labels = [o.get('label') if isinstance(o, dict) else o for o in captured_options]
                if labels != [o['label'] for o in options]: continue
                choices = [o['value'] for o in options if value in (o['label'], o['value'])]
                if len(choices) != 1: continue
                value = [choices[0]] if field['type'] == 'select-multiple' else choices[0]
            if field['type'] in {'checkbox', 'custom-checkbox'}:
                if value not in ('true', 'false', 'Yes', 'No'): continue
                value = value in ('true', 'Yes')
            if isinstance(value, (str, list, bool)) and value != '':
                matches.append((captured, {'value':value, **{k:row[k] for k in ('questionZh','answerZh') if isinstance(row.get(k),str)}}))
        return max(matches, key=lambda row: row[0])[1] if matches else None
