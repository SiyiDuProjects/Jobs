"""Optional monotonic request budget; ordinary operations retain their defaults."""
import contextvars
import time

DEADLINE = contextvars.ContextVar('jobs_request_deadline', default=None)


class BudgetExceeded(TimeoutError):
    pass


def remaining(default=30.0):
    deadline = DEADLINE.get()
    if deadline is None: return default
    seconds = deadline - time.monotonic()
    if seconds <= 0: raise BudgetExceeded('request_budget_exceeded')
    return min(default, seconds)
