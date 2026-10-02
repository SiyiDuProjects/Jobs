"""Release write pause; a persistent flag survives a process restart."""
import os
from pathlib import Path

from starlette.responses import JSONResponse


def paused():
    try:
        Path(os.environ.get('JOBS_MAINTENANCE_FILE', '/data/.release-maintenance')).stat()
    except FileNotFoundError:
        return False
    except OSError:
        # An unreadable marker is not evidence that release writes may resume.
        return True
    return True


class ReleaseMaintenance:
    """Block before authentication: even a read may update session timestamps.

    Only immutable assets, public discovery and liveness remain available while
    a release owns the database. Lifespan events always reach the MCP transport.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and paused():
            path = scope.get('path', '')
            public = path in {'/', '/healthz', '/full-time', '/internships', '/trash'} or path.startswith(
                ('/assets/', '/manage/', '/.well-known/'))
            if scope['method'] not in {'GET', 'HEAD'} or not public:
                response = JSONResponse({'error': 'Service update in progress; retry after the update'},
                                        status_code=503, headers={'Retry-After': '30', 'Cache-Control': 'no-store'})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
