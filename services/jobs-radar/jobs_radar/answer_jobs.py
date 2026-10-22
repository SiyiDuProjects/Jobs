"""Short HTTP exchanges around long answers; never replay interrupted model work."""
import asyncio
import hashlib
import json
import os
import time
import uuid
from .async_work import run_sync
from .answer_timing import CURRENT

ANSWER_TIMEOUT_SECONDS = 120
QUEUE_TIMEOUT_SECONDS = 480
DEFAULT_CONCURRENT_BATCHES = 16


class AnswerJobs:
    def __init__(self, store, answers):
        self.store, self.answers, self.tasks = store, answers, {}
        concurrency = int(os.environ.get('JOBS_ANSWER_CONCURRENCY', DEFAULT_CONCURRENT_BATCHES))
        if concurrency < 1:
            raise ValueError('JOBS_ANSWER_CONCURRENCY must be a positive integer')
        self.slots = asyncio.Semaphore(concurrency)
        with store.connect(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_jobs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,created REAL NOT NULL,state TEXT NOT NULL,result TEXT)')

    def status(self, request_id):
        if not isinstance(request_id, str):
            raise ValueError('Invalid answer request ID')
        request_id = str(uuid.UUID(request_id))
        with self.store.connect(read_only=True) as c:
            row = c.execute('SELECT * FROM answer_jobs WHERE id=?', (request_id,)).fetchone()
        if not row:
            raise ValueError('回答任务不存在，请重新开始填写')
        # Only orphan recovery is a write. Recheck under the lock so a result
        # committed between the read and recovery is never overwritten.
        if row['state'] == 'pending' and time.time() - row['created'] > 120 and request_id not in self.tasks:
            with self.store.connect(True) as c:
                c.execute("UPDATE answer_jobs SET state='failed',result=? WHERE id=? AND state='pending' AND created<?",
                          (json.dumps({'error':'回答任务已中断，请检查后重试'}), request_id, time.time()-120))
                row = c.execute('SELECT * FROM answer_jobs WHERE id=?', (request_id,)).fetchone()
        return {'requestId':request_id,'state':row['state'],**({'result':json.loads(row['result'])} if row['result'] else {})}

    def _register(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('Invalid answer request')
        payload = dict(payload)
        request_id = payload.pop('requestId', None)
        if not isinstance(request_id, str):
            raise ValueError('Invalid answer request ID')
        request_id = str(uuid.UUID(request_id))
        digest = hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.store.connect(True) as c:
            c.execute('DELETE FROM answer_jobs WHERE created<?', (time.time()-86400,))
            row = c.execute('SELECT digest FROM answer_jobs WHERE id=?', (request_id,)).fetchone()
            if row:
                if row['digest'] != digest:
                    raise ValueError('回答任务标识已被其他题目使用')
            else:
                c.execute('INSERT INTO answer_jobs VALUES(?,?,?,?,NULL)', (request_id,digest,time.time(),'pending'))
        return request_id, payload, not row

    def _schedule(self, request_id, payload, created):
        if created:
            task = asyncio.create_task(self._run(request_id, payload))
            self.tasks[request_id] = task
            task.add_done_callback(lambda _: self.tasks.pop(request_id, None))

    def start(self, payload):
        """Synchronous compatibility entrypoint for local callers already on a loop."""
        request_id, payload, created = self._register(payload)
        self._schedule(request_id, payload, created)
        return self.status(request_id)

    async def start_async(self, payload):
        request_id, payload, created = await run_sync(self._register, payload)
        self._schedule(request_id, payload, created)
        return await run_sync(self.status, request_id)

    def _finish(self, request_id, state, result):
        with self.store.connect(True) as c:
            c.execute("UPDATE answer_jobs SET state=?,result=? WHERE id=? AND state='pending'",
                      (state, json.dumps(result, ensure_ascii=False), request_id))

    async def _run(self, request_id, payload):
        timings = {}
        token = CURRENT.set(timings)
        state = 'completed'
        started = time.monotonic()
        queued_ms = None
        def failed(message, error):
            # wait_for keeps the cancelled coroutine's exception as its cause.
            usage = getattr(error, 'answer_usage', None) or getattr(error.__cause__, 'answer_usage', None)
            return {'error': message, **({'answerUsage': usage} if usage else {})}
        try:
            # HTTP read timeouts only bound each idle interval. A slow response
            # can otherwise outlive the persisted task and keep consuming work
            # after the client has been told it failed. Preserve the existing
            # 120-second answer window. A live task owns its timeout result;
            # status() only expires orphaned work, avoiding a polling race.
            await asyncio.wait_for(self.slots.acquire(), timeout=QUEUE_TIMEOUT_SECONDS)
            queued_ms = (time.monotonic() - started) * 1000
            try:
                result = await asyncio.wait_for(self.answers.generate(payload), timeout=ANSWER_TIMEOUT_SECONDS)
            finally:
                self.slots.release()
        except TimeoutError as error:
            state, result = 'failed', failed('回答超时，当前填写内容已保留，请重试', error)
        except asyncio.CancelledError as error:
            state, result = 'failed', failed('回答任务已中断，请检查后重试', error)
        except (ValueError, KeyError, TypeError) as error:
            state, result = 'failed', failed(str(error)[:600], error)
        except Exception:
            state, result = 'failed', {'error':'回答任务失败，未填入任何答案'}
        elapsed_ms = (time.monotonic()-started)*1000
        if queued_ms is None: queued_ms = elapsed_ms
        timings.update(queueMs=queued_ms,processingMs=elapsed_ms-queued_ms)
        result['answerTimings'] = {key:min(86_400_000,max(0,round(value))) for key,value in timings.items()}
        CURRENT.reset(token)
        await run_sync(self._finish, request_id, state, result)
