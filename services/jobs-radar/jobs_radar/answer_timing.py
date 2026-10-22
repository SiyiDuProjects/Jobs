"""Per-request phase durations, carried by existing answer diagnostics only."""
from contextvars import ContextVar
import time

from .async_work import run_sync

CURRENT = ContextVar('answer_timings', default=None)


def add(name, seconds):
    value = CURRENT.get()
    if value is not None:
        value[name] = value.get(name, 0) + seconds * 1000


async def database(function, *args, **kwargs):
    started = time.monotonic()
    try:
        return await run_sync(function, *args, **kwargs)
    finally:
        add('storageMs', time.monotonic()-started)


def request_state(store, request_id, state, *, created=None):
    with store.connect(True) as c:
        if created is not None:
            c.execute('INSERT OR IGNORE INTO answer_requests VALUES(?,?,?)', (request_id,created,state))
        else:
            c.execute('UPDATE answer_requests SET state=? WHERE id=?', (state,request_id))
