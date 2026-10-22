"""Bounded blocking work; each operation owns its complete SQLite transaction."""
import asyncio
from functools import partial, wraps
from weakref import WeakKeyDictionary

from anyio import CapacityLimiter, to_thread

_pools = WeakKeyDictionary()


async def run_sync(function, *args, **kwargs):
    loop = asyncio.get_running_loop()
    limiter = _pools.get(loop)
    if limiter is None:
        limiter = _pools[loop] = CapacityLimiter(8)
    return await to_thread.run_sync(partial(function, *args, **kwargs), limiter=limiter)


def worker(function):
    @wraps(function)
    async def dispatch(*args, **kwargs):
        return await run_sync(function, *args, **kwargs)
    return dispatch
