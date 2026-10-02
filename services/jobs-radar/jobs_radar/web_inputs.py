"""Typed request envelopes. Domain validators enforce the contained contracts."""
from typing import Any, Literal
from .http_routes import RequestModel


class ProgressRequest(RequestModel):
    application_id: str
    stage: str
    expected_version: int
    idempotency_key: str
    summary: str
    action: str = 'set'
    interview_round: int | None = None
    is_final: bool | None = None
    observed_at: str | None = None
    assessment_type: str | None = None


class ApplicationChange(RequestModel):
    action: Literal['create', 'update', 'delete']
    application_id: str | None = None
    expected_version: int | None = None
    value: dict[str, Any] | None = None


class ApplicationRequest(RequestModel):
    changes: list[ApplicationChange]
    idempotency_key: str


class StateRequest(RequestModel):
    changes: list[dict[str, Any]]


class PairRequest(RequestModel):
    device_id: str
    extension_id: str
    profiles: bool = False


class DeviceRequest(RequestModel):
    device_id: str


class ResolveRequest(RequestModel):
    url: str
    website_job_id: str | None = None


class ReceiptRequest(RequestModel):
    event_id: str
    job_url: str | None = None
    observed_at: str | None = None
    proof: Literal['ats_confirmation', 'tracker_record', 'submit_attempt', 'submit_validation_error',
                   'ats_unavailable', 'manual_remove', 'undo_unavailable']
    job_title: str | None = None
    company: str | None = None
    website_job_id: str | None = None
    profile_id: str | None = None
    profile_name: str | None = None
    run_id: str | None = None
    detail: str | None = None
    code: str | None = None
    quote: str | None = None
    removal_event: str | None = None


class AnswerJobRequest(RequestModel):
    requestId: str
    profileId: str
    profileVersion: str
    prompt: str | None = None
    fields: list[dict[str, Any]] | None = None
    formContext: list[dict[str, str]] | None = None
    additionalContext: str | None = None
    jobTitle: str | None = None
    jobDescription: str | None = None


class BoardAction(RequestModel):
    action: Literal['submitted', 'undo_submitted', 'opened', 'review']
    job_id: str
    version: int | None = None
    key: str | None = None
    reference: str | None = None
    dismiss: bool | None = None
    kind: str | None = None
    decision: str | None = None
    reason: str | None = None
    detail: str | None = None
    evidence: list[dict[str, Any]] | None = None
    expected_fingerprint: str | None = None
    expected_version: int | None = None
    idempotency_key: str | None = None
    role_family: str | None = None
    role_evidence: list[dict[str, Any]] | None = None
