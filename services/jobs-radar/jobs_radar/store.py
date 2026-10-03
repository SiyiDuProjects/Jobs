import hashlib
import json
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .identity import identity, stable_id
from .scope import STREAM_IDS, discovery_scope

STATES = {"not_started", "in_progress", "needs_input", "submitted_unconfirmed", "submitted", "retryable_failure", "skipped"}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,identity TEXT UNIQUE,first_seen REAL,last_seen REAL);
            CREATE TABLE IF NOT EXISTS job_aliases(alias_id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL,created REAL);
            CREATE TABLE IF NOT EXISTS observations(stream TEXT,source_id TEXT,job_id TEXT,payload TEXT,
                first_seen REAL,last_seen REAL,present INTEGER DEFAULT 1,PRIMARY KEY(stream,source_id));
            CREATE INDEX IF NOT EXISTS observations_job ON observations(job_id);
            CREATE TABLE IF NOT EXISTS search_index(stream TEXT,source_id TEXT,job_id TEXT,source TEXT,kind TEXT,
                category TEXT,title_company TEXT,locations TEXT,h1b TEXT,active INTEGER,visible INTEGER,posted_at REAL,
                PRIMARY KEY(stream,source_id));
            CREATE INDEX IF NOT EXISTS search_posted ON search_index(active,visible,posted_at);
            CREATE INDEX IF NOT EXISTS search_job ON search_index(job_id);
            CREATE TABLE IF NOT EXISTS snapshots(stream TEXT,source_id TEXT,hash TEXT,observed_at REAL,payload TEXT,
                PRIMARY KEY(stream,source_id,hash));
            CREATE TABLE IF NOT EXISTS source_health(stream TEXT PRIMARY KEY,last_attempt REAL,last_success REAL,
                count INTEGER,error TEXT,run_id TEXT);
            CREATE TABLE IF NOT EXISTS applications(job_id TEXT PRIMARY KEY,status TEXT,version INTEGER DEFAULT 0,
                updated REAL,detail TEXT DEFAULT '',evidence TEXT DEFAULT '[]',owner_run_id TEXT);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,job_id TEXT,event TEXT,actor TEXT,created REAL,payload TEXT);
            CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY,hash TEXT,result TEXT);
            CREATE TABLE IF NOT EXISTS web_opened(job_id TEXT,kind TEXT,opened_at REAL,PRIMARY KEY(job_id,kind));
            CREATE TABLE IF NOT EXISTS recruiting_sync(mailbox TEXT PRIMARY KEY,last_success REAL,summary TEXT);
            CREATE TABLE IF NOT EXISTS owner_submission_undo(job_id TEXT PRIMARY KEY,version INTEGER,expires REAL,application TEXT,reviews TEXT);
            CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT,expires REAL);
            CREATE TABLE IF NOT EXISTS job_role_family(job_id TEXT,kind TEXT,family TEXT,fingerprint TEXT,
                evidence TEXT,updated REAL,PRIMARY KEY(job_id,kind));
            CREATE TABLE IF NOT EXISTS job_screening(job_id TEXT,kind TEXT,state TEXT,reason TEXT,detail TEXT,
                evidence TEXT,fingerprint TEXT,reviewed_at REAL,expires_at REAL,version INTEGER DEFAULT 1,
                manual_keep INTEGER DEFAULT 0,PRIMARY KEY(job_id,kind));
            """)
            c.execute("""INSERT OR IGNORE INTO search_index SELECT stream,source_id,job_id,
                json_extract(payload,'$.source'),json_extract(payload,'$.kind'),json_extract(payload,'$.category'),
                lower(json_extract(payload,'$.title') || ' ' || json_extract(payload,'$.company') || ' ' || coalesce(json_extract(payload,'$.description'),'')),
                lower(json_extract(payload,'$.locations')),json_extract(payload,'$.h1b'),
                coalesce(json_extract(payload,'$.active'),1),coalesce(json_extract(payload,'$.visible'),1),
                json_extract(payload,'$.posted_at') FROM observations
                WHERE present=1 OR stream NOT IN ('simplify:newgrad','simplify:internship')""")
        from .application_schema import initialize
        initialize(self)
        from .job_titles import initialize as initialize_titles
        with self.connect() as c:
            initialize_titles(c)

    @contextmanager
    def connect(self, write=False):
        from .request_budget import DEADLINE, BudgetExceeded, remaining
        deadline = DEADLINE.get()
        timeout = remaining()
        c = sqlite3.connect(self.path, timeout=timeout)
        try:
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys=ON")
            c.execute('PRAGMA busy_timeout=' + str(max(1, int(remaining() * 1000))))
            if deadline is not None:
                c.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            if write:
                c.execute("BEGIN IMMEDIATE")
            yield c
            if deadline is not None:
                c.execute('PRAGMA busy_timeout=' + str(max(1, int(remaining() * 1000))))
            c.commit()
        except Exception as error:
            c.set_progress_handler(None, 0)
            c.rollback()
            if isinstance(error, sqlite3.OperationalError) and deadline is not None and (
                    str(error) == 'interrupted' or 'locked' in str(error) and time.monotonic() >= deadline - .01):
                raise BudgetExceeded('request_budget_exceeded') from None
            raise
        finally:
            c.close()

    def ingest(self, stream, observations, run_id, *, scoped_only=False):
        if scoped_only and stream not in STREAM_IDS:
            raise ValueError("Source is outside the four approved repositories")
        if not observations:
            raise ValueError("Empty source snapshot; old data retained for inspection")
        now = time.time()
        accepted = 0
        accepted_ids = set()
        with self.connect(True) as c:
            from .job_match import posting_key, job_index
            from .job_duplicates import preferred_job
            matches = job_index(c)
            c.execute("UPDATE observations SET present=0 WHERE stream=?", (stream,))
            for observation in observations:
                observation = dict(observation)
                previous = c.execute("SELECT payload,job_id FROM observations WHERE stream=? AND source_id=?", (stream, observation["source_id"])).fetchone()
                if previous and observation.get("time_precision") == "approximate_day":
                    old = json.loads(previous[0])
                    if old.get("posted_at") and observation.get("posted_at"):
                        observation["posted_at"] = min(old["posted_at"], observation["posted_at"])
                if scoped_only and observation.get("posted_at") is not None and observation["posted_at"] > now:
                    continue
                accepted += 1
                key = identity(observation["apply_url"]) if observation.get("apply_url") else f"{observation['source']}:{observation['source_id']}"
                jid = stable_id(key)
                match_key = posting_key(observation.get("apply_url"))
                candidates = matches.get(match_key, set())
                if candidates:
                    # Existing duplicates are consolidated only by the explicit
                    # migration, never silently by an ordinary collector refresh.
                    jid = previous['job_id'] if previous and previous['job_id'] in candidates else preferred_job(c, candidates)
                    key = c.execute('SELECT identity FROM jobs WHERE id=?', (jid,)).fetchone()[0]
                else:
                    alias = c.execute('SELECT canonical_id FROM job_aliases WHERE alias_id=?', (jid,)).fetchone()
                    if alias:
                        jid = alias[0]
                        key = c.execute('SELECT identity FROM jobs WHERE id=?', (jid,)).fetchone()[0]
                if match_key:
                    matches.setdefault(match_key, set()).add(jid)
                accepted_ids.add(jid)
                c.execute("INSERT INTO jobs(id,identity,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen", (jid, key, now, now))
                payload = encoded(observation)
                c.execute("INSERT INTO observations VALUES(?,?,?,?,?,?,1) ON CONFLICT(stream,source_id) DO UPDATE SET job_id=excluded.job_id,payload=excluded.payload,last_seen=excluded.last_seen,present=1",
                          (stream, observation["source_id"], jid, payload, now, now))
                c.execute("INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)", (stream, observation["source_id"], hashlib.sha256(payload.encode()).hexdigest(), now, payload))
                c.execute("""INSERT INTO search_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stream,source_id)
                    DO UPDATE SET job_id=excluded.job_id,source=excluded.source,kind=excluded.kind,category=excluded.category,
                    title_company=excluded.title_company,locations=excluded.locations,h1b=excluded.h1b,
                    active=excluded.active,visible=excluded.visible,posted_at=excluded.posted_at""",
                    (stream, observation["source_id"], jid, observation["source"], observation["kind"], observation.get("category", ""),
                     (observation["title"] + " " + observation["company"] + " " + observation.get("description", "")).casefold(),
                     " ".join(observation.get("locations", [])).casefold(), observation.get("h1b"),
                     observation.get("active", True), observation.get("visible", True), observation.get("posted_at")))
                c.execute("INSERT OR IGNORE INTO applications(job_id,status,updated) VALUES(?,?,?)", (jid, "not_started", now))
                c.execute("UPDATE jobs SET job_key=? WHERE id=?", (match_key, jid))
                c.execute("UPDATE applications SET job_key=? WHERE job_id=?", (match_key, jid))
            if scoped_only:
                from .screening import screen_titles
                screen_titles(c, accepted_ids, now)
            from .application_records import reconcile
            reconcile(c,accepted_ids)
            c.execute("INSERT INTO source_health VALUES(?,?,?,?,?,?) ON CONFLICT(stream) DO UPDATE SET last_attempt=excluded.last_attempt,last_success=excluded.last_success,count=excluded.count,error=NULL,run_id=excluded.run_id", (stream, now, now, accepted, None, run_id))
        return accepted

    def screen_titles(self):
        """Backfill the same title rules for already synchronized, untouched roles."""
        from .screening import screen_titles
        with self.connect(True) as c:
            return screen_titles(c)

    def source_error(self, stream, error, run_id):
        with self.connect(True) as c:
            c.execute("INSERT INTO source_health VALUES(?,?,NULL,0,?,?) ON CONFLICT(stream) DO UPDATE SET last_attempt=excluded.last_attempt,error=excluded.error,run_id=excluded.run_id", (stream, time.time(), error[:500], run_id))

    def health(self):
        with self.connect() as c:
            sources = [dict(r) for r in c.execute("SELECT * FROM source_health ORDER BY stream") if r["stream"] in STREAM_IDS]
            from .sources import ACTIVE_STREAMS
            known = {s["stream"] for s in sources}
            sources.extend({"stream": s.id, "last_attempt": None, "last_success": None, "count": 0, "error": "not_collected", "run_id": None} for s in ACTIVE_STREAMS if s.id not in known)
            for s in sources:
                s["stale"] = not s["last_success"] or time.time() - s["last_success"] > 7200 or bool(s["error"])
            return {"sources": sources, "jobs": c.execute("SELECT count(*) FROM jobs").fetchone()[0],
                    "observations": c.execute("SELECT count(*) FROM observations").fetchone()[0], "expected_streams": len(STREAM_IDS),
                    "storage": self.storage_health()}

    def storage_health(self):
        free = shutil.disk_usage(self.path.parent).free
        return {"database_bytes": self.path.stat().st_size, "disk_free_bytes": free,
                "low_disk": free < 1024 ** 3, "snapshot_retention_days": 30}

    def prune_snapshots(self):
        # Keep the current source payload even when it has not changed for 30 days.
        with self.connect(True) as c:
            return c.execute("""DELETE FROM snapshots WHERE observed_at<? AND NOT EXISTS
                (SELECT 1 FROM observations o WHERE o.stream=snapshots.stream
                 AND o.source_id=snapshots.source_id AND o.payload=snapshots.payload)""",
                (time.time() - 30 * 86400,)).rowcount

    def get_jobs(self, ids, include_raw=False):
        if len(ids) > 100:
            raise ValueError("At most 100 job IDs")
        result = []
        with self.connect() as c:
            for jid in ids:
                alias = c.execute('SELECT canonical_id FROM job_aliases WHERE alias_id=?', (jid,)).fetchone()
                if alias: jid = alias[0]
                row = c.execute("SELECT j.*,a.status,a.version,a.detail,a.evidence FROM jobs j JOIN applications a ON j.id=a.job_id WHERE j.id=?", (jid,)).fetchone()
                if row:
                    if any(job['id'] == jid for job in result): continue
                    job = dict(row)
                    job["evidence"] = json.loads(job["evidence"])
                    job["all_sources"] = [{**json.loads(r["payload"]), "stream": r["stream"], "first_seen": r["first_seen"], "last_seen": r["last_seen"], "present": bool(r["present"])} for r in c.execute("SELECT * FROM observations WHERE job_id=? ORDER BY stream", (jid,))]
                    if not include_raw:
                        for source in job["all_sources"]:
                            source.pop("raw", None)
                    result.append(job)
        return result

    def search(self, *, text="", location="CA", kind=None, sources=None, categories=None,
               posted_within_hours=None, active_only=True,
               statuses=None, limit=25, cursor=None):
        if not 1 <= limit <= 100:
            raise ValueError("limit must be 1..100")
        if posted_within_hours is not None and posted_within_hours <= 0:
            raise ValueError("posted_within_hours must be positive")
        if statuses is not None and not set(statuses) <= STATES:
            raise ValueError("Unknown application status")
        scope, values = discovery_scope()
        conditions = [scope, "NOT EXISTS (SELECT 1 FROM job_screening q WHERE q.job_id=s.job_id AND q.kind=s.kind AND q.state='trash')"]
        if cursor:
            conditions.append("s.job_id>?"); values.append(cursor)
        if active_only:
            conditions.append("o.present=1 AND s.active=1 AND s.visible=1")
        if location:
            conditions.append("instr(s.locations,?)>0"); values.append(location.casefold())
        if text:
            conditions.append("instr(s.title_company,?)>0"); values.append(text.casefold())
        if kind:
            conditions.append("s.kind=?"); values.append(kind)
        for column, items in [("a.status", statuses), ("s.source", sources), ("s.category", categories)]:
            if items is not None:
                conditions.append(column + " IN (" + ",".join("?" for _ in items) + ")"); values.extend(items)
        if posted_within_hours is not None:
            conditions.append("s.posted_at>=?"); values.append(time.time() - posted_within_hours * 3600)
        with self.connect() as c:
            rows = c.execute("SELECT s.job_id,group_concat(DISTINCT s.stream) AS streams FROM search_index s JOIN observations o ON o.stream=s.stream AND o.source_id=s.source_id JOIN applications a ON a.job_id=s.job_id WHERE " + " AND ".join(conditions) + " GROUP BY s.job_id ORDER BY s.job_id LIMIT ?", [*values, limit + 1]).fetchall()
        matched = {r["job_id"]: sorted(r["streams"].split(",")) for r in rows}
        ids = sorted(matched)[:limit]
        jobs = self.get_jobs(ids)
        for job in jobs:
            job["matched_sources"] = matched[job["id"]]
            primary = next(s for s in job["all_sources"] if s["stream"] in job["matched_sources"])
            job.update({k: primary.get(k) for k in ["title", "company", "locations", "kind", "apply_url", "source_url", "posted_at", "time_precision"]})
            for source in job["all_sources"]:
                source.pop("description", None)
        health = self.health()
        return {"jobs": jobs, "next_cursor": ids[-1] if len(matched) > limit else None,
                "data_as_of": min((s["last_success"] for s in health["sources"] if s["last_success"]), default=None),
                "source_health": health["sources"], "location_semantics": "case-insensitive substring; not geographic verification"}

    def filter_options(self):
        scope, values = discovery_scope()
        with self.connect() as c:
            return {"kinds": [{"value": "newgrad", "label": "全职"}, {"value": "internship", "label": "实习"}],
                    "categories": [dict(r) for r in c.execute(f"""SELECT s.source,s.kind,s.category,count(DISTINCT s.job_id) AS count
                        FROM search_index s JOIN observations o USING(stream,source_id)
                        WHERE o.present=1 AND s.active=1 AND s.visible=1
                        AND {scope} AND NOT EXISTS (SELECT 1 FROM job_screening q WHERE q.job_id=s.job_id AND q.kind=s.kind AND q.state='trash')
                        GROUP BY s.source,s.kind,s.category ORDER BY s.source,s.kind,s.category""", values)],
                    "application_statuses": sorted(STATES), "default_filters": {"sources": ["simplify", "speedyapply"], "posted_within_hours": None, "location": "CA", "active_only": True}}

    def prune_simplify(self, stream, dry_run=False):
        """Discard unused retired source data after a successful scoped collection.

        Touched applications and their provenance remain available by job ID.
        Retired provenance is removed from discovery even with active_only=False.
        """
        if stream not in {"simplify:newgrad", "simplify:internship"}:
            raise ValueError("Only scoped Simplify streams may be pruned")
        with self.connect(True) as c:
            current = c.execute("SELECT payload FROM observations WHERE stream=? AND present=1", (stream,)).fetchall()
            health = c.execute("SELECT error FROM source_health WHERE stream=?", (stream,)).fetchone()
            if not current or not health or health[0] or any(json.loads(r[0]).get("collection_scope") not in {"readme-three-tracks-v1", "json-three-tracks-v2"} for r in current):
                raise ValueError("Successful scoped collection required before pruning")
            c.execute("""CREATE TEMP TABLE discarded AS SELECT o.stream,o.source_id,o.job_id
                FROM observations o JOIN applications a ON a.job_id=o.job_id JOIN jobs j ON j.id=o.job_id
                WHERE o.stream=? AND o.present=0 AND a.status='not_started' AND a.version=0
                AND a.detail='' AND a.evidence='[]' AND a.owner_run_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM audit WHERE job_id=o.job_id)
                AND NOT EXISTS (SELECT 1 FROM job_screening WHERE job_id=o.job_id)
""", (stream,))
            result = {"stream": stream, "discarded_observations": c.execute("SELECT count(*) FROM discarded").fetchone()[0],
                      "retired_index_entries": c.execute("""SELECT count(*) FROM search_index s JOIN observations o USING(stream,source_id)
                          WHERE o.stream=? AND o.present=0""", (stream,)).fetchone()[0], "dry_run": dry_run}
            if not dry_run:
                c.execute("DELETE FROM search_index WHERE stream=? AND source_id IN (SELECT source_id FROM observations WHERE stream=? AND present=0)", (stream, stream))
                c.execute("DELETE FROM snapshots WHERE (stream,source_id) IN (SELECT stream,source_id FROM discarded)")
                c.execute("DELETE FROM observations WHERE (stream,source_id) IN (SELECT stream,source_id FROM discarded)")
                # Shared-source jobs and all application history survive.
                orphaned = "SELECT job_id FROM discarded WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.job_id=discarded.job_id)"
                c.execute("DELETE FROM applications WHERE job_id IN (" + orphaned + ")")
                c.execute("DELETE FROM jobs WHERE id IN (" + orphaned + ")")
            return result

    def _idem(self, c, key, payload):
        if not 8 <= len(key) <= 200:
            raise ValueError("idempotency_key must contain 8..200 characters")
        digest = hashlib.sha256(encoded(payload).encode()).hexdigest()
        old = c.execute("SELECT hash,result FROM idempotency WHERE key=?", (key,)).fetchone()
        if old and old["hash"] != digest:
            raise ValueError("Idempotency key was used for different arguments")
        return digest, json.loads(old["result"]) if old else None

    def require_current_job(self, c, jid):
        if c.execute('SELECT 1 FROM job_aliases WHERE alias_id=?', (jid,)).fetchone():
            raise ValueError('岗位已合并，请刷新列表后重试')

    def progress(self):
        with self.connect() as c:
            return {"counts": {r[0]: r[1] for r in c.execute("SELECT status,count(*) FROM applications WHERE job_id NOT IN (SELECT alias_id FROM job_aliases) GROUP BY status")}}

    def backup(self, destination):
        dest = Path(destination)
        if dest.resolve() == self.path.resolve():
            raise ValueError("Backup destination must differ from the live database")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(dest.parent).free < self.path.stat().st_size + 256 * 1024 ** 2:
            raise ValueError("Insufficient free disk space for a verified backup")
        with self.connect() as source, sqlite3.connect(dest) as target:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Backup integrity check failed")
        return str(dest)
