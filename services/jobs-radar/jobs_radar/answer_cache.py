"""Private answer cache, isolated by Profile, revisions and request context."""
import hashlib
import json
import time

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

class AnswerCache:
    def __init__(self, store, namespace):
        self.store, self.namespace = store, namespace
        with store.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS simple_answer_cache(key TEXT PRIMARY KEY,answer TEXT NOT NULL,created REAL NOT NULL)')

    def key(self, field, job, memory_revision):
        shape = {k:v for k,v in field.items() if k not in {'fieldId','options'}}
        shape['options'] = [o['label'] for o in field['options']]
        return digest([self.namespace, memory_revision, shape, job])

    def get(self, field, job, memory_revision):
        with self.store.connect() as c:
            for key in (self.key(field, job, memory_revision), self.key(field, None, memory_revision)):
                row = c.execute('SELECT answer FROM simple_answer_cache WHERE key=?', (key,)).fetchone()
                if not row: continue
                answer = json.loads(row['answer'])
                if field['options']:
                    labels = answer.pop('choiceLabels', None)
                    if not isinstance(labels, list) or not labels: continue
                    values = []
                    for label in labels:
                        matches = [o['value'] for o in field['options'] if o['label'] == label]
                        if len(matches) != 1: break
                        values.append(matches[0])
                    else:
                        answer['value'] = values if field['type']=='select-multiple' else values[0]
                        return answer | {'fieldId':field['fieldId']}
                else: return answer | {'fieldId':field['fieldId']}

    def put(self, field, job, answer, memory_revision):
        if answer['kind'] == 'unknown': return
        stored = {k:v for k,v in answer.items() if k not in {'binding','fieldId'}}
        if field['options']:
            values = answer['value'] if isinstance(answer['value'],list) else [answer['value']]
            labels = [o['label'] for o in field['options'] if o['value'] in values]
            if len(labels)!=len(values) or any(sum(o['label']==label for o in field['options'])!=1 for label in labels): return
            stored['choiceLabels'] = labels
            stored.pop('value')
        key = self.key(field,job if answer.get('jobSpecific',True) else None,memory_revision)
        with self.store.connect(True) as c:
            c.execute('INSERT OR REPLACE INTO simple_answer_cache VALUES(?,?,?)',(key,json.dumps(stored,ensure_ascii=False),time.time()))
