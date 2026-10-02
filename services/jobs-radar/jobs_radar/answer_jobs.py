"""Short HTTP exchanges around long answers; never replay interrupted model work."""
import asyncio
import hashlib
import json
import time
import uuid

ANSWER_TIMEOUT_SECONDS = 120


class AnswerJobs:
    def __init__(self, store, answers):
        self.store, self.answers, self.tasks = store, answers, {}
        with store.connect(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_jobs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,created REAL NOT NULL,state TEXT NOT NULL,result TEXT)')

    def status(self, request_id):
        if not isinstance(request_id, str):
            raise ValueError('Invalid answer request ID')
        request_id = str(uuid.UUID(request_id))
        with self.store.connect(True) as c:
            row = c.execute('SELECT * FROM answer_jobs WHERE id=?', (request_id,)).fetchone()
            if not row:
                raise ValueError('回答任务不存在，请重新开始填写')
            # A process interruption must not silently start another billable call.
            if row['state'] == 'pending' and time.time() - row['created'] > 120 and request_id not in self.tasks:
                c.execute("UPDATE answer_jobs SET state='failed',result=? WHERE id=?", (json.dumps({'error':'回答任务已中断，请检查后重试'}), request_id))
                row = c.execute('SELECT * FROM answer_jobs WHERE id=?', (request_id,)).fetchone()
        return {'requestId':request_id,'state':row['state'],**({'result':json.loads(row['result'])} if row['result'] else {})}

    def start(self, payload):
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
                if c.execute('SELECT count(*) FROM answer_jobs WHERE created>?', (time.time()-3600,)).fetchone()[0] >= 60:
                    raise ValueError('本小时 AI 请求较多，请稍后再试')
                c.execute('INSERT INTO answer_jobs VALUES(?,?,?,?,NULL)', (request_id,digest,time.time(),'pending'))
        if not row:
            task = asyncio.create_task(self._run(request_id, payload))
            self.tasks[request_id] = task
            task.add_done_callback(lambda _: self.tasks.pop(request_id, None))
        return self.status(request_id)

    async def _run(self, request_id, payload):
        state = 'completed'
        try:
            # HTTP read timeouts only bound each idle interval. A slow response
            # can otherwise outlive the persisted task and keep consuming work
            # after the client has been told it failed. Preserve the existing
            # 120-second answer window. A live task owns its timeout result;
            # status() only expires orphaned work, avoiding a polling race.
            result = await asyncio.wait_for(self.answers.generate(payload), timeout=ANSWER_TIMEOUT_SECONDS)
        except TimeoutError:
            state, result = 'failed', {'error':'回答超时，当前填写内容已保留，请重试'}
        except asyncio.CancelledError:
            state, result = 'failed', {'error':'回答任务已中断，请检查后重试'}
        except (ValueError, KeyError, TypeError) as error:
            state, result = 'failed', {'error':str(error)[:600]}
        except Exception:
            state, result = 'failed', {'error':'回答任务失败，未填入任何答案'}
        with self.store.connect(True) as c:
            c.execute("UPDATE answer_jobs SET state=?,result=? WHERE id=? AND state='pending'", (state,json.dumps(result,ensure_ascii=False),request_id))
