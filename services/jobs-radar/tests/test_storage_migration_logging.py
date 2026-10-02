"""Synthetic HTTP failures log only fixed codes/statuses, without changing responses."""
from contextlib import asynccontextmanager
import logging

import pytest
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from jobs_radar.client_protocol import CURRENT_HEADERS
from jobs_radar.http_routes import RequestModel, RouteAPI
from jobs_radar.storage_migration_contract import MigrationError
from jobs_radar.storage_migration_routes import register_storage_migration_routes


SECRET = 'SYNTHETIC-PRIVATE-MARKER-observability'
LOGGER = 'jobs_radar.storage_migration_routes'
BASE = '/api/extension/storage-migrations'


class Server:
    def __init__(self):
        self.routes = []

    def custom_route(self, path, methods):
        def register(handler):
            self.routes.append(Route(path, handler, methods=methods))
            return handler
        return register


class Migrations:
    error = None
    admission_error = None

    @asynccontextmanager
    async def admission(self):
        if self.admission_error:
            raise self.admission_error
        yield

    def status(self, *args):
        if self.error:
            raise self.error
        return {'phase': 'synthetic-ready'}

    create = status


@pytest.fixture
def api(caplog):
    caplog.set_level(logging.WARNING)
    service = Migrations()
    server = Server()
    routes = RouteAPI(server, write_paused=lambda: False)
    register_storage_migration_routes(routes, service, lambda request: SECRET)

    class Ordinary(RequestModel):
        count: int

    @routes.route('/ordinary-fields', ['POST'], lambda request: True, model=Ordinary)
    def ordinary_fields(request, data, principal):
        return {'count': data.count}

    @routes.route('/ordinary-data', ['GET'], lambda request: True)
    def ordinary_data(request, data, principal):
        raise ValueError(SECRET)

    with TestClient(Starlette(routes=server.routes), headers={**CURRENT_HEADERS, 'Authorization': 'Bearer ' + SECRET}) as client:
        yield client, service


def assert_response(response, status, body):
    assert response.status_code == status
    assert response.json() == body
    assert response.headers['cache-control'] == 'no-store'


def assert_warning(caplog, code, status):
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert (record.name, record.levelno) == (LOGGER, logging.WARNING)
    assert record.msg == 'storage_migration_rejected code=%s status=%d'
    assert record.args == (code, status)
    assert record.exc_info is None and record.stack_info is None
    assert SECRET not in caplog.text
    assert SECRET not in repr(vars(record))


@pytest.mark.parametrize('code,status', [
    ('migration_auth_required', 401),
    ('migration_owner_mismatch', 404),
    ('migration_plan_stale', 409),
    ('migration_limit', 503),
])
def test_migration_failure_logs_only_code_status_and_keeps_response(api, caplog, code, status):
    client, service = api
    service.error = MigrationError(code, status)
    service.error.args = (SECRET,)  # An exception message must never reach the logger.
    response = client.get(BASE + '/' + SECRET, params={'choiceId': SECRET})
    assert_response(response, status, {'error': code, 'code': code})
    assert_warning(caplog, code, status)


def test_admission_limit_is_logged_once_without_request_details(api, caplog):
    client, service = api
    service.admission_error = MigrationError('migration_limit', 503)
    service.admission_error.args = (SECRET,)
    response = client.post(BASE, json={'syntheticSecret': SECRET})
    assert_response(response, 503, {'error': 'migration_limit', 'code': 'migration_limit'})
    assert_warning(caplog, 'migration_limit', 503)


def test_unknown_migration_code_is_never_copied_into_logs(api, caplog):
    client, service = api
    service.error = MigrationError(SECRET, 409)
    response = client.get(BASE + '/' + SECRET)
    # Preserve the existing response contract, while bounding the new logging surface.
    assert_response(response, 409, {'error': SECRET, 'code': SECRET})
    assert_warning(caplog, 'migration_error', 409)


def test_field_error_hides_pydantic_input_and_keeps_response(api, caplog):
    client, _ = api
    response = client.post(BASE, json={'protocolVersion': SECRET, 'manifestText': SECRET, 'manifestHash': SECRET})
    assert_response(response, 400, {'error': 'Invalid request fields'})
    assert_warning(caplog, 'migration_invalid_fields', 400)


def test_unsupported_content_type_logs_fixed_415_without_body(api, caplog):
    client, _ = api
    response = client.post(BASE, content=SECRET, headers={'Content-Type': 'text/plain'})
    assert_response(response, 415, {'error': 'JSON required'})
    assert_warning(caplog, 'migration_json_required', 415)


def test_outer_body_limit_logs_fixed_413_without_body(api, caplog):
    client, _ = api
    response = client.post(BASE + '/' + SECRET + '/seal', content=SECRET + ' ' * 16384,
                           headers={'Content-Type': 'application/json'})
    assert_response(response, 413, {'error': 'Request too large'})
    assert_warning(caplog, 'migration_request_too_large', 413)


@pytest.mark.parametrize('raw', [
    '{"syntheticSecret":"' + SECRET + '",',
    '{"syntheticSecret":"' + SECRET + '","syntheticSecret":"duplicate"}',
])
def test_strict_json_error_hides_body_and_keeps_response(api, caplog, raw):
    client, _ = api
    response = client.post(BASE, content=raw, headers={'Content-Type': 'application/json'})
    assert_response(response, 400, {'error': 'migration_invalid_source', 'code': 'migration_invalid_source'})
    assert_warning(caplog, 'migration_invalid_source', 400)


@pytest.mark.parametrize('error_type', [ValueError, KeyError, TypeError, RecursionError])
def test_caught_data_error_hides_exception_and_keeps_response(api, caplog, error_type):
    client, service = api
    service.error = error_type(SECRET)
    response = client.get(BASE + '/' + SECRET)
    assert_response(response, 400, {'error': 'Invalid request data'})
    assert_warning(caplog, 'migration_invalid_data', 400)


def test_successful_migration_requests_produce_no_warning(api, caplog):
    client, _ = api
    assert_response(client.get(BASE + '/' + SECRET), 200, {'phase': 'synthetic-ready'})
    response = client.post(BASE, json={'protocolVersion': 2, 'manifestText': SECRET, 'manifestHash': SECRET})
    assert_response(response, 200, {'phase': 'synthetic-ready'})
    assert caplog.records == []


def test_other_routes_keep_their_errors_and_do_not_log(api, caplog):
    client, _ = api
    assert_response(client.post('/ordinary-fields', json={'count': SECRET}), 400, {'error': 'Invalid request fields'})
    assert_response(client.get('/ordinary-data'), 400, {'error': 'Invalid request data'})
    assert caplog.records == []


def test_unhandled_admission_exception_is_not_reclassified_or_logged(api, caplog):
    client, service = api
    service.admission_error = ValueError(SECRET)
    with pytest.raises(ValueError, match=SECRET):
        client.get(BASE + '/' + SECRET)
    assert caplog.records == []
