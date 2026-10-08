"""A calendar fact computed by the server in the extension's declared zone."""
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def calendar_fact(context, now=None):
    try:
        data = json.loads(context)
        zone = data.get('timeZone') if isinstance(data, dict) else None
        if not isinstance(zone, str) or not 1 <= len(zone) <= 100:
            return {}
        local = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(zone))
        return {'today': local.date().isoformat()}
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        return {}
