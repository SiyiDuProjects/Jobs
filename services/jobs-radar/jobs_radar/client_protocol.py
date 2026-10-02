"""One current private HTTP protocol; retired clients may never write data."""
from starlette.responses import JSONResponse
from .profile_contract import VERSION as PROFILE_SCHEMA_VERSION

HEADER = 'X-Jobs-Protocol'
VERSION = '2'
CURRENT_HEADERS = {HEADER: VERSION}
UPGRADE_MESSAGE = '客户端版本已停用，请升级 Jobs 插件或刷新网站后重试；本次请求未写入任何数据。'


def upgrade_required():
    return JSONResponse(
        {'error': UPGRADE_MESSAGE, 'code': 'client_upgrade_required',
         'protocol_version': int(VERSION), 'profile_schema_version': PROFILE_SCHEMA_VERSION},
        status_code=426,
        headers={**CURRENT_HEADERS, 'Cache-Control': 'no-store'},
    )


def require_current(request):
    return None if request.headers.get(HEADER) == VERSION else upgrade_required()


def register_retired_routes(api, authorize):
    """Tombstones contain no former implementation or compatibility writes."""
    paths = ['/api/manage/answer', '/api/ext/sync/profile', '/api/ext/sync/profile/list']
    for path in paths:
        @api.route(path, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], authorize)
        async def retired(request, payload, principal):
            return upgrade_required()
