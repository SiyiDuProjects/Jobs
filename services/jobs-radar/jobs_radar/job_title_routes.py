"""Bounded, device-authenticated transport for ATS list title observations."""
from typing import Literal
import hashlib

from .http_routes import RequestModel
from .job_titles import JobTitles


class JobTitleRequest(RequestModel):
    url: str
    title: str
    title_source: Literal['existing_adapter']
    observed_at: str
    website_job_id: str | None = None


def register_job_title_routes(api, store, authorize):
    titles = JobTitles(store)

    @api.route('/api/extension/job-title', ['POST'], authorize, JobTitleRequest, max_bytes=6000)
    async def update_title(request, payload, device):
        expected = hashlib.sha256(request.headers['authorization'][7:].encode()).hexdigest()
        return titles.update(device,payload.model_dump(exclude_none=True),expected_token_hash=expected)
