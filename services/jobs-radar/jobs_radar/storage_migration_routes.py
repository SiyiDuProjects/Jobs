"""Private explicit migration endpoints, using the ordinary Profile grant."""
import logging
from typing import Literal
from pydantic import Field

from .http_routes import RequestModel, json_response
from .storage_migration_contract import CONTRACT, LIMITS, MigrationError, strict_json


LOGGER = logging.getLogger(__name__)
LOG_ERROR_CODES = frozenset(CONTRACT['errors'])
INVALID_REQUEST_ERRORS = {
    'fields': ('migration_invalid_fields', 400),
    'data': ('migration_invalid_data', 400),
    'content_type': ('migration_json_required', 415),
    'body_limit': ('migration_request_too_large', 413),
}


def log_invalid_request(reason):
    code, status = INVALID_REQUEST_ERRORS[reason]
    LOGGER.warning('storage_migration_rejected code=%s status=%d', code, status)


class Begin(RequestModel):
    protocolVersion: Literal[2]
    manifestText: str
    manifestHash: str


class Entry(RequestModel):
    jsonText: str
    size: int = Field(ge=0, le=LIMITS['maxEntryBytes'])
    sha256: str


class ManifestReference(RequestModel):
    manifestHash: str


class Supersede(ManifestReference):
    replacementMigrationId: str


class Resolve(RequestModel):
    planRevision: int = Field(ge=1)
    conflictId: str
    choiceId: str
    previewId: str | None = None


class Apply(ManifestReference):
    planRevision: int = Field(ge=1)


class Claim(ManifestReference):
    entryId: str
    sha256: str
    clientBuild: str
    observedState: Literal['present', 'session_absent']
    containerBeforeSha256: str | None = None


class Ack(ManifestReference):
    entryId: str
    permitId: str
    result: Literal['absent', 'path_absent', 'session_expired']
    containerAfterSha256: str | None = None


class Complete(ManifestReference):
    legacyRemaining: Literal[0]


def register_storage_migration_routes(api, migrations, authorize, *, prefix='/api/extension/storage-migrations'):
    def error_response(error):
        if isinstance(error, MigrationError):
            # Only contract-owned codes and bounded integer statuses may enter logs.
            code = error.code if type(error.code) is str and error.code in LOG_ERROR_CODES else 'migration_error'
            status = error.status if type(error.status) is int and 400 <= error.status <= 599 else 500
            LOGGER.warning('storage_migration_rejected code=%s status=%d', code, status)
            return json_response({'error': error.code, 'code': error.code}, error.status)
    def route(path, methods, model=None, max_bytes=16384):
        return api.route(prefix + path, methods, authorize, model=model, max_bytes=max_bytes,
                         admission=migrations.admission,
                         decoder=lambda raw: strict_json(raw, max_bytes=max_bytes)[0], error_response=error_response,
                         on_invalid_request=log_invalid_request)
    @route('', ['POST'], Begin, max_bytes=LIMITS['maxManifestBytes'] * 6 + 4096)
    def begin(request, data, device):
        return migrations.create(device, data.manifestText, data.manifestHash)
    @route('/{migration_id}', ['GET'])
    def status(request, data, device):
        return migrations.status(device, request.path_params['migration_id'])
    @route('/{migration_id}/entries/{entry_id}', ['PUT'], Entry, max_bytes=LIMITS['maxEntryRequestBytes'])
    def upload(request, data, device):
        return migrations.upload(device, request.path_params['migration_id'], request.path_params['entry_id'], data.jsonText, data.size, data.sha256)
    @route('/{migration_id}/supersede', ['POST'], Supersede)
    def supersede(request, data, device):
        return migrations.supersede(device, request.path_params['migration_id'], data.manifestHash, data.replacementMigrationId)
    @route('/{migration_id}/seal', ['POST'], ManifestReference)
    def seal(request, data, device):
        return migrations.seal(device, request.path_params['migration_id'], data.manifestHash)
    @route('/{migration_id}/plan', ['GET'])
    def plan(request, data, device):
        return migrations.plan(device, request.path_params['migration_id'])
    @route('/{migration_id}/resolve', ['POST'], Resolve)
    def resolve(request, data, device):
        return migrations.resolve(device, request.path_params['migration_id'], data.planRevision, data.conflictId, data.choiceId, data.previewId)
    @route('/{migration_id}/conflicts/{conflict_id}/preview', ['GET'])
    def preview(request, data, device):
        return migrations.preview(device, request.path_params['migration_id'], request.path_params['conflict_id'],
                                  request.query_params.get('choiceId'), request.query_params.get('cursor'))
    @route('/{migration_id}/apply', ['POST'], Apply)
    def apply(request, data, device):
        return migrations.apply(device, request.path_params['migration_id'], data.planRevision, data.manifestHash)
    @route('/{migration_id}/verify', ['POST'], ManifestReference)
    def verify(request, data, device):
        return migrations.verify(device, request.path_params['migration_id'], data.manifestHash)
    @route('/{migration_id}/cleanup-claim', ['POST'], Claim)
    def claim(request, data, device):
        return migrations.claim(device, request.path_params['migration_id'], data.entryId, data.manifestHash,
                                data.sha256, data.clientBuild, data.containerBeforeSha256, data.observedState)
    @route('/{migration_id}/cleanup-ack', ['POST'], Ack)
    def ack(request, data, device):
        return migrations.ack(device, request.path_params['migration_id'], data.entryId, data.permitId,
                              data.manifestHash, data.result, data.containerAfterSha256)
    @route('/{migration_id}/complete', ['POST'], Complete)
    def complete(request, data, device):
        return migrations.complete(device, request.path_params['migration_id'], data.manifestHash, data.legacyRemaining)
