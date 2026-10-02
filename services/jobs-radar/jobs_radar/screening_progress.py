"""Durable screening batches, independent of the scheduler's cadence.

Each begin snapshots job identities. New identities after begin wait for the
next batch; failed or interrupted batches keep their original membership.
Older ordinary jobs stay visible on the board without entering the initial backlog.
"""
import json
import secrets
import time

from .board import Board, KINDS, RULES
from .intern_companies import normalize_company


class ScreeningProgress:
    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS screening_checkpoint(
                    id INTEGER PRIMARY KEY CHECK(id=1), cutoff REAL NOT NULL, initialized INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS screening_batches(
                    id TEXT PRIMARY KEY, since REAL NOT NULL, cutoff REAL NOT NULL,
                    status TEXT NOT NULL, completed REAL);
                CREATE UNIQUE INDEX IF NOT EXISTS screening_one_active
                    ON screening_batches(status) WHERE status='active';
                CREATE TABLE IF NOT EXISTS screening_seen(
                    job_id TEXT, kind TEXT, fingerprint TEXT NOT NULL, present INTEGER NOT NULL,
                    PRIMARY KEY(job_id,kind));
                CREATE TABLE IF NOT EXISTS screening_batch_items(
                    run_id TEXT, job_id TEXT, kind TEXT, PRIMARY KEY(run_id,job_id,kind));
                CREATE TABLE IF NOT EXISTS screening_rechecks(
                    source_run TEXT, job_id TEXT, kind TEXT, review_version INTEGER NOT NULL,
                    PRIMARY KEY(source_run,job_id,kind));
            ''')

    def initialize(self, cutoff):
        """Owner migration only; never reset an existing checkpoint."""
        if not isinstance(cutoff, (float, int)) or not 0 < cutoff <= time.time():
            raise ValueError('Invalid initial checkpoint')
        with self.store.connect(True) as c:
            c.execute('INSERT OR IGNORE INTO screening_checkpoint VALUES(1,?,0)', (cutoff,))

    @staticmethod
    def included(row):
        # Owner's excluded company should not consume daily AI screening work.
        return normalize_company(row['company']) != normalize_company('TikTok')

    @staticmethod
    def pending(row):
        return (ScreeningProgress.included(row) and row['status']=='not_started' and row['application_version']==0
                and row['screening']=='pending'
                and not (row['review'] and row['review']['manual_keep']))

    def _current(self):
        b = Board(self.store)
        return [row for kind in sorted(KINDS) for row in b._rows(kind)]

    def request_recheck(self, source_run):
        """Owner repair: retry unresolved members without erasing any prior review.

        This is intentionally not exposed as an autonomous MCP action. A repeated
        repair request cannot requeue a review that has already been corrected.
        """
        with self.store.connect(True) as c:
            batch = c.execute('SELECT * FROM screening_batches WHERE id=?',(source_run,)).fetchone()
            if not batch or batch['status']!='complete':
                raise ValueError('Recheck requires an existing completed batch')
            ids = {(r[0],r[1]) for r in c.execute(
                'SELECT job_id,kind FROM screening_batch_items WHERE run_id=?',(source_run,))}
            count = 0
            for row in self._current():
                prior = row['review']
                if (not self.included(row) or (row['id'],row['kind']) not in ids or row['status']!='not_started'
                        or row['application_version']!=0 or not prior or prior['manual_keep']
                        or row['screening']!='review' or json.loads(prior['evidence'])
                        or not batch['cutoff']<=prior['reviewed_at']<=batch['completed']
                        or row['role_basis']=='duties'):
                    continue
                count += c.execute('INSERT OR IGNORE INTO screening_rechecks VALUES(?,?,?,?)',
                    (source_run,row['id'],row['kind'],row['review_version'])).rowcount
            c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('screening_recheck','owner-repair',?,?)",
                      (time.time(),json.dumps({'source_run':source_run,'added':count})))
            return {'source_run':source_run,'added':count}

    @staticmethod
    def _rechecks(c, current):
        versions = {}
        for r in c.execute('SELECT job_id,kind,max(review_version) FROM screening_rechecks GROUP BY job_id,kind'):
            versions[(r[0],r[1])] = r[2]
        return {(r['id'],r['kind']) for r in current
                if ScreeningProgress.included(r) and r['status']=='not_started' and r['application_version']==0
                and r['screening']=='review' and not r['review']['manual_keep']
                and r['review_version']<=versions.get((r['id'],r['kind']),-1)}

    def _remaining(self, c, run_id, current=None):
        ids = {(r['job_id'],r['kind']) for r in c.execute(
            'SELECT job_id,kind FROM screening_batch_items WHERE run_id=?', (run_id,))}
        current = self._current() if current is None else current
        rechecks = self._rechecks(c,current)
        return [r for r in current if (r['id'],r['kind']) in ids
                and (self.pending(r) or (r['id'],r['kind']) in rechecks)]

    def _describe(self, c, batch, remaining=None):
        remaining = self._remaining(c,batch['id']) if remaining is None else remaining
        return {**dict(batch), 'remaining':{k:sum(r['kind']==k for r in remaining) for k in sorted(KINDS)},
                'progress_unit':'canonical job id + kind + content fingerprint; timestamps are metadata only after initialization',
                'policy':'Newly collected or materially changed jobs only; resume unfinished eligible work. No automatic historical backfill. TikTok excluded from daily screening. No rolling-day expiry.'}

    def manage(self, action, run_id=None):
        if action not in {'begin','status','complete'}: raise ValueError('Invalid screening run action')
        with self.store.connect(action!='status') as c:
            checkpoint = c.execute('SELECT * FROM screening_checkpoint WHERE id=1').fetchone()
            if not checkpoint: raise ValueError('Screening progress must be initialized by the owner')
            if action=='complete':
                batch = c.execute('SELECT * FROM screening_batches WHERE id=?',(run_id,)).fetchone()
                if not batch: raise ValueError('Unknown screening run')
                if batch['status']=='complete': return self._describe(c,batch,[])
                remaining = self._remaining(c,run_id)
                if remaining:
                    return {**self._describe(c,batch,remaining),'completed':False}
                now = time.time()
                c.execute("UPDATE screening_batches SET status='complete',completed=? WHERE id=?",(now,run_id))
                c.execute('UPDATE screening_checkpoint SET cutoff=? WHERE id=1',(batch['cutoff'],))
                c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('screening_checkpoint','gpt-work',?,?)",
                          (now,json.dumps({'run_id':run_id,'cutoff':batch['cutoff']})))
                return self._describe(c,c.execute('SELECT * FROM screening_batches WHERE id=?',(run_id,)).fetchone(),[])
            batch = c.execute("SELECT * FROM screening_batches WHERE status='active'").fetchone()
            if batch: return self._describe(c,batch)
            if action=='status': return {'status':'idle','cutoff':checkpoint['cutoff'],'remaining':None}
            # The write lock prevents collection/reviews changing while membership
            # and the observed fingerprints are snapshotted together.
            cutoff = time.time()
            current = self._current()
            rechecks = self._rechecks(c,current)
            seen = {(r['job_id'],r['kind']):r for r in c.execute('SELECT * FROM screening_seen')}
            admitted = {(r['job_id'],r['kind']) for r in c.execute('SELECT DISTINCT job_id,kind FROM screening_batch_items')}
            run_id = secrets.token_hex(12)
            c.execute("INSERT INTO screening_batches VALUES(?,?,?,'active',NULL)",(run_id,checkpoint['cutoff'],cutoff))
            c.execute('UPDATE screening_seen SET present=0')
            selected = []
            for r in current:
                old = seen.get((r['id'],r['kind']))
                changed = old and (not old['present'] or old['fingerprint']!=r['fingerprint'])
                newly_seen = checkpoint['initialized'] and not old
                bootstrap = not checkpoint['initialized'] and (r['added_at']>=checkpoint['cutoff'] or r['review'])
                if ((r['id'],r['kind']) in rechecks or
                        self.pending(r) and (changed or newly_seen or bootstrap or (r['id'],r['kind']) in admitted)):
                    c.execute('INSERT INTO screening_batch_items VALUES(?,?,?)',(run_id,r['id'],r['kind']))
                    selected.append(r)
                c.execute('INSERT OR REPLACE INTO screening_seen VALUES(?,?,?,1)',(r['id'],r['kind'],r['fingerprint']))
            c.execute('UPDATE screening_checkpoint SET initialized=1 WHERE id=1')
            return self._describe(c,c.execute('SELECT * FROM screening_batches WHERE id=?',(run_id,)).fetchone(),selected)

    def queue(self, run_id, kind, limit=50, cursor=None):
        if kind not in KINDS or not 1<=limit<=100: raise ValueError('Invalid kind or limit')
        with self.store.connect() as c:
            batch = c.execute('SELECT * FROM screening_batches WHERE id=?',(run_id,)).fetchone()
            if not batch: raise ValueError('Unknown screening run')
            if batch['status']=='complete':
                return {'jobs':[],'next_cursor':None,'run':self._describe(c,batch,[]),'rules':RULES}
            remaining = self._remaining(c,run_id)
            rows = sorted((r for r in remaining if r['kind']==kind
                           and (not cursor or r['id']>cursor)),key=lambda r:r['id'])
            selected = rows[:limit]
            rules = {**RULES,'screening_scope':'Daily screening processes newly collected or materially changed jobs, plus unfinished eligible work. No automatic historical backfill for any company, including FAANG+. TikTok is excluded from AI screening, without deleting its jobs. Some unverified incremental items may already show review; screen their titles and available metadata and write the new review version. Website history remains unlimited. Resume by job identity, not a rolling-day expiry.',
                     'screening_mode':'Start from upstream repository/README classifications in all_sources, then judge the actual occupation from titles and existing metadata. Source SWE/AI labels and legacy role_family hints are not proof of relevance. Do not open every official page or require full descriptions. Remove only an explicitly authorized category supported by the available evidence; otherwise keep visible. keep means title triage passed, not verified eligibility. Use review only for a specific ambiguity, never simply because the queue lacks official text. Omit role_family/role_evidence for title-only decisions; legacy title classifications are internal hints only and are not shown as website filters. Never infer sponsorship, clearance or eligibility from silence.'}
            return {'jobs':selected,'next_cursor':selected[-1]['id'] if len(rows)>limit else None,
                    'run':self._describe(c,batch,remaining),'rules':rules}
