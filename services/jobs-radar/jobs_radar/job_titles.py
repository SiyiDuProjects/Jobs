"""ATS-observed list titles, separate from application and source history."""
from datetime import datetime
import json
import math
import re
import time
import unicodedata

from .identity import identity
from .job_match import resolve


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS job_title_overrides(
        job_id TEXT PRIMARY KEY, job_key TEXT NOT NULL, title TEXT NOT NULL,
        title_source TEXT NOT NULL, ats TEXT NOT NULL,
        observed_at REAL NOT NULL, updated_at REAL NOT NULL)''')


def display_titles(c):
    return {r['job_id']:r['title'] for r in c.execute('SELECT job_id,title FROM job_title_overrides')}


class JobTitles:
    def __init__(self, store):
        self.store = store

    def update(self, device_id, payload, *, expected_token_hash):
        if not isinstance(expected_token_hash,str) or not re.fullmatch('[a-f0-9]{64}',expected_token_hash):
            raise ValueError('Device authorization expired')
        if not isinstance(payload, dict) or set(payload) - {'url','title','title_source','observed_at','website_job_id'}:
            raise ValueError('Invalid job title request')
        url, title, hint = payload.get('url'), payload.get('title'), payload.get('website_job_id')
        if (not isinstance(url, str) or len(url)>2000 or not isinstance(title, str)
                or not 1<=len(title)<=500 or payload.get('title_source')!='existing_adapter'
                or hint is not None and (not isinstance(hint,str) or not re.fullmatch('[0-9a-f]{24}',hint))):
            raise ValueError('Invalid job title request')
        identity(url)
        title = title.strip()
        if not title or any(unicodedata.category(char) in {'Cc','Cs'} for char in title):
            raise ValueError('Invalid job title')
        observed = payload.get('observed_at')
        if not isinstance(observed,str) or len(observed)>80:
            raise ValueError('Invalid title observation time')
        try:
            parsed = datetime.fromisoformat(observed.replace('Z','+00:00'))
            stamp = parsed.timestamp() if parsed.tzinfo is not None else 0
        except (ValueError, OverflowError):
            raise ValueError('Invalid title observation time') from None
        if not math.isfinite(stamp):
            raise ValueError('Invalid title observation time')
        with self.store.connect(True) as c:
            now = time.time()
            if not max(1577836800,now-86400)<=stamp<=now+600:
                raise ValueError('Invalid title observation time')
            if not c.execute('SELECT 1 FROM extension_devices WHERE device_id=? AND token_hash=? AND revoked=0 AND expires>?',
                    (device_id,expected_token_hash,now)).fetchone():
                raise ValueError('Device authorization expired')
            ids, _ = resolve(c,url,hint)
            if len(ids)!=1:
                return {'ok':False,'changed':False,'reason':'ambiguous' if ids else 'unmatched'}
            jid = ids[0]
            job = c.execute('SELECT job_key FROM jobs WHERE id=?',(jid,)).fetchone()
            if not job or not job['job_key']:
                raise ValueError('Listed job identity missing')
            # Use the already ingested identity, never the page URL/query,
            # which can contain transient credentials on a form navigation.
            key = job['job_key']
            ats = json.loads(key)[1]
            previous = c.execute('SELECT * FROM job_title_overrides WHERE job_id=?',(jid,)).fetchone()
            result = {'ok':True,'job_id':jid,'job_key':key,'title':previous['title'] if previous else title,'changed':False}
            if previous and title==previous['title']:
                if stamp>previous['observed_at']:
                    c.execute('UPDATE job_title_overrides SET observed_at=? WHERE job_id=?',(stamp,jid))
                return {**result,'reason':'duplicate'}
            if previous and stamp<=previous['observed_at']:
                return {**result,'reason':'stale'}
            c.execute('''INSERT INTO job_title_overrides VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET
                job_key=excluded.job_key,title=excluded.title,title_source=excluded.title_source,
                ats=excluded.ats,observed_at=excluded.observed_at,updated_at=excluded.updated_at''',
                (jid,key,title,'existing_adapter',ats,stamp,now))
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'job_title_display','jobs-extension',?,?)",
                (jid,now,json.dumps({'before':previous['title'] if previous else None,'after':title,
                    'job_key':key,'ats':ats,'title_source':'existing_adapter','observed_at':stamp},ensure_ascii=False)))
            return {**result,'title':title,'changed':True,'reason':'updated'}
