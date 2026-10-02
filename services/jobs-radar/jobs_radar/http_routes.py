"""Shared bounded JSON transport for authenticated private REST routes."""
import inspect
import json
from functools import wraps

from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.responses import JSONResponse, Response

from .profiles import ProfileConflict
from .browser_control import ControlConflict


class RequestModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


def json_response(value, status=200):
    return JSONResponse(value, status_code=status, headers={'Cache-Control': 'no-store'})


class RouteAPI:
    def __init__(self, server, *, write_paused=None):
        self.server = server
        self.write_paused = write_paused

    def route(self, path, methods, authorize, model=None, max_bytes=120000, *, admission=None, decoder=json.loads, error_response=None, on_invalid_request=None):
        def decorate(handler):
            @wraps(handler)
            async def dispatch(request):
                if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
                    from .client_protocol import require_current
                    incompatible = require_current(request)
                    if incompatible is not None:
                        return incompatible
                principal = authorize(request)
                if inspect.isawaitable(principal):
                    principal = await principal
                if isinstance(principal, Response):
                    return principal
                if not principal:
                    return json_response({'error': 'Authenticated jobs access required'}, 401)
                from .maintenance import paused
                if request.method != 'GET' and (self.write_paused or paused)():
                    return json_response({'error': 'Release maintenance; keep pending work and retry later'}, 503)
                try:
                    payload = None
                    if request.method != 'GET' and (request.method != 'DELETE' or model is not None):
                        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
                            if on_invalid_request is not None:
                                on_invalid_request('content_type')
                            return json_response({'error': 'JSON required'}, 415)
                        body = bytearray()
                        async for chunk in request.stream():
                            if len(body) + len(chunk) > max_bytes:
                                if on_invalid_request is not None:
                                    on_invalid_request('body_limit')
                                return json_response({'error': 'Request too large'}, 413)
                            body.extend(chunk)
                        payload = decoder(body)
                        if model:
                            payload = model.model_validate(payload)
                        elif not isinstance(payload, dict):
                            raise ValueError('JSON object required')
                    result = handler(request, payload, principal)
                    if inspect.isawaitable(result):
                        result = await result
                    return result if isinstance(result, Response) else json_response(result)
                except (ProfileConflict, ControlConflict) as error:
                    return json_response({'error': str(error)}, 409)
                except ValidationError:
                    # Pydantic errors can echo personal input; never return their raw form.
                    if on_invalid_request is not None:
                        on_invalid_request('fields')
                    return json_response({'error': 'Invalid request fields'}, 400)
                except (ValueError, KeyError, TypeError, RecursionError) as error:
                    if error_response is not None:
                        response = error_response(error)
                        if response is not None:
                            return response
                    if on_invalid_request is not None:
                        on_invalid_request('data')
                    return json_response({'error': 'Invalid request data'}, 400)
            if admission is not None:
                inner = dispatch
                @wraps(handler)
                async def admitted(request):
                    try:
                        async with admission():
                            return await inner(request)
                    except Exception as error:
                        if error_response is not None:
                            response = error_response(error)
                            if response is not None:
                                return response
                        raise
                dispatch = admitted
            self.server.custom_route(path, methods=methods)(dispatch)
            return dispatch
        return decorate
