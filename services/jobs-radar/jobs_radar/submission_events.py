"""Shared ordering rule for receipt and history replays after an owner undo."""
from datetime import datetime


def observed_timestamp(value):
    if not isinstance(value, str):
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else 0
    except ValueError:
        try:
            return datetime.strptime(value.split(' (')[0], '%a %b %d %Y %H:%M:%S GMT%z').timestamp()
        except ValueError:
            return 0


def blocked_by_owner_undo(connection, job_id, observed):
    undo = connection.execute(
        "SELECT max(created) FROM audit WHERE job_id=? AND event='owner_submission_undo'",
        (job_id,),
    ).fetchone()[0]
    return bool(undo and undo >= observed_timestamp(observed))
