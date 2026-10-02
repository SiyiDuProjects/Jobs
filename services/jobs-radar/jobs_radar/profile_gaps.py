"""Private adapter candidates from Luna, never an autofill rule or Saved Response."""
import hashlib
import json
import time

class ProfileGaps:
    def __init__(self,store):
        self.store=store
        with store.connect() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS answer_profile_gaps(
              profile_id TEXT,question TEXT,control_type TEXT,field TEXT,answer TEXT,reason TEXT,
              profile_stamp TEXT,first_seen REAL,last_seen REAL,occurrences INTEGER,
              PRIMARY KEY(profile_id,question,control_type))''')

    def record(self,pid,profile,fields,answers):
        by_id={f['fieldId']:f for f in fields}
        stamp=hashlib.sha256(json.dumps(profile,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        now=time.time()
        with self.store.connect(True) as c:
            for row in answers:
                if row['state']!='answer' or row['source']!='profile' or row['value'] in (None,'',[]):continue
                field=by_id[row['fieldId']]
                c.execute('''INSERT INTO answer_profile_gaps VALUES(?,?,?,?,?,?,?,?,?,1)
                  ON CONFLICT(profile_id,question,control_type) DO UPDATE SET
                  field=excluded.field,answer=excluded.answer,reason=excluded.reason,
                  profile_stamp=excluded.profile_stamp,last_seen=excluded.last_seen,occurrences=occurrences+1''',
                  (pid,field['question'],field['type'],json.dumps(field,ensure_ascii=False),
                   json.dumps(row['value'],ensure_ascii=False),row['reason'],stamp,now,now))
