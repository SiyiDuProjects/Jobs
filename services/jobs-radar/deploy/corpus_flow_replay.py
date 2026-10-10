"""Private stdin/stdout bridge to the real extension snapshot runtime."""
import asyncio
import hashlib
import json
from pathlib import Path

from jobs_radar.job_match import resolve


def posting_context(connection, page):
    """Only a captured public posting identity can join a job. Never match titles."""
    url = page.get('jobIdentity') or ''
    empty = {'title': '', 'locations': [], 'description': '', 'complete': False,
             'source': 'missing_job_identity' if not url else 'posting_not_in_library'}
    if not url:
        return empty
    ids, method = resolve(connection, url)
    if not ids:
        return empty
    marks = ','.join('?' for _ in ids)
    rows = connection.execute(
        f'SELECT payload FROM observations WHERE job_id IN ({marks}) ORDER BY last_seen DESC, stream, source_id', ids)
    observations = [json.loads(row[0]) for row in rows]
    if not observations:
        return empty
    # Read existing snapshots, not a live scrape. Fill only fields available in
    # the same identity group; preserve evidence when feeds lack descriptions.
    title = next((row.get('title') for row in observations if row.get('title')), '')
    locations = next((row.get('locations') for row in observations if row.get('locations')), [])
    description = next((row.get('description') for row in observations if row.get('description')), '')
    return {'title': title, 'locations': locations, 'description': description,
            'complete': bool(title and locations and description),
            'source': 'readonly_job_library', 'jobIds': ids, 'matchMethod': method}


def replay_code_hash(extension):
    root = Path(extension)
    files = [*root.joinpath('src/custom').glob('*.js'),
             *root.joinpath('tests/helpers').glob('*.mjs'),
             *root.joinpath('scripts').glob('corpus*.mjs')]
    return hashlib.sha256(b''.join(str(p.relative_to(root)).encode() + p.read_bytes()
                                   for p in sorted(files))).hexdigest()


class SnapshotReplay:
    def __init__(self, extension, node='node', read_timeout=120):
        self.extension = Path(extension).resolve()
        self.node = node
        self.process = None
        self.read_timeout = read_timeout

    async def __aenter__(self):
        await self.start()
        return self

    async def start(self):
        self.process = await asyncio.create_subprocess_exec(
            self.node, str(self.extension / 'scripts/corpus-flow-worker.mjs'),
            cwd=self.extension, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=32 * 1024 * 1024)

    async def send(self, value):
        self.process.stdin.write((json.dumps(value, ensure_ascii=False) + '\n').encode())
        await self.process.stdin.drain()

    async def run(self, page, profile, bound, job, generate):
        if self.process is None or self.process.returncode is not None:
            await self.start()
        try:
            return await self.exchange(page, profile, bound, job, generate)
        except BaseException:
            # A broken/timed-out page gets no retry. Kill its worker so the next
            # page starts clean and cannot consume a late answer for this one.
            if self.process.returncode is None:
                self.process.kill()
                await self.process.wait()
            self.process = None
            raise

    async def exchange(self, page, profile, bound, job, generate):
        await self.send({'page': page, 'profile': profile, 'bound': bound, 'job': job})
        while True:
            line = await asyncio.wait_for(self.process.stdout.readline(), timeout=self.read_timeout)
            if not line:
                raise RuntimeError('Snapshot replay worker ended without a result')
            message = json.loads(line)
            if message['type'] == 'result':
                return message['result']
            if message['type'] == 'failure':
                raise RuntimeError('Snapshot replay failed: ' + message['errorType'])
            if message['type'] != 'generate':
                raise RuntimeError('Unexpected snapshot replay message')
            try:
                response = await generate(message['request'])
            except Exception:
                # Abort the page; do not convert a provider failure to a factual
                # unknown or leave the worker waiting for its request forever.
                await self.send({'type': 'answer', 'error': True})
            else:
                await self.send({'type': 'answer', 'result': response})

    async def __aexit__(self, *_):
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
