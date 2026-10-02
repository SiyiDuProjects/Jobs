"""One discovery boundary for collection, the board, MCP and claims."""
import time

STREAM_IDS = (
    'simplify:newgrad', 'simplify:internship',
    'speedyapply:SWE:internship', 'speedyapply:SWE:newgrad',
    'speedyapply:AI:internship', 'speedyapply:AI:newgrad',
)


def discovery_scope(now=None):
    """Approved repositories across all dates; optional query filters may narrow."""
    now = time.time() if now is None else now
    return ('s.stream IN (' + ','.join('?' for _ in STREAM_IDS) +
            ') AND (s.posted_at IS NULL OR s.posted_at<=?)', [*STREAM_IDS, now])
