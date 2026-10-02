"""Profile REST handlers using the shared bounded/authenticated transport."""
from pydantic import Field
from .http_routes import RequestModel, json_response
from .profile_contract import VERSION
from .client_protocol import upgrade_required


class ProfileWrite(RequestModel):
    profile: dict
    expected_sync: str | None = None
    schema_version: int = Field(default=VERSION)


class ProfileDelete(RequestModel):
    expected_sync: str = Field(min_length=1)


class ProfileCreate(ProfileWrite):
    id: str | None = Field(default=None, min_length=32, max_length=36)


def register_profile_routes(api, profiles, authorize, *, prefix="/api/manage/profiles"):
    """The host supplies owner/origin authorization or the dedicated Profile grant."""
    @api.route(prefix, ["GET"], authorize)
    async def listing(request, payload, principal):
        return profiles.list()

    @api.route(prefix, ["POST"], authorize, model=ProfileCreate, max_bytes=9 * 1024 * 1024)
    async def create(request, payload, principal):
        if response := check_version(payload):
            return response
        return profiles.save(payload.profile, profile_id=str(payload.id) if payload.id else None,
                             allow_create=True, create_only=True)

    @api.route(prefix + "/{profile_id}", ["GET"], authorize)
    async def read(request, payload, principal):
        try:
            return profiles.get(request.path_params["profile_id"])
        except KeyError:
            return json_response({"error": "Profile not found"}, 404)

    @api.route(prefix + "/{profile_id}", ["PUT"], authorize, model=ProfileWrite, max_bytes=9 * 1024 * 1024)
    async def update(request, payload, principal):
        if response := check_version(payload):
            return response
        try:
            return profiles.save(payload.profile, profile_id=request.path_params["profile_id"], expected_sync=payload.expected_sync)
        except KeyError:
            return json_response({"error": "Profile not found"}, 404)

    @api.route(prefix + "/{profile_id}", ["DELETE"], authorize, model=ProfileDelete, max_bytes=4096)
    async def remove(request, payload, principal):
        try:
            return profiles.delete(request.path_params["profile_id"], expected_sync=payload.expected_sync)
        except KeyError:
            return json_response({"error": "Profile not found"}, 404)


def check_version(payload):
    if payload.schema_version != VERSION:
        return upgrade_required()
