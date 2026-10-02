# Jobs Radar

Private job collection, Profiles, application records and supervised browser integration. The authenticated MCP endpoint is `https://jobs.siyidu.com/mcp`. This document describes current source; it does not assert that a candidate is deployed. Verified releases and remaining checks are in [the implementation report](../../notes/archive/dod-implementation-2026-09-26.md).

## Data and interfaces

The four approved Simplify and SpeedyApply repositories provide six streams. [Collector configuration](config/collector.json) owns the cohort and repository templates. Simplify admits only README-linked Software, Quant, and AI/ML/Data roles and enriches them from JSON. Failed or inconsistent snapshots preserve prior data. SpeedyApply dates remain approximate. The two pools are `newgrad` and `internship`; history has no default rolling date cutoff. Source metadata is not independent proof of eligibility. Location matching is a substring filter. Provenance and source freshness remain visible.

[Job matching rules](jobs_radar/job_match_rules.json) define posting identity for the service and generated extension rules. Privacy-safe URLs are separate from identity. Similar titles alone do not merge jobs. Migration stops for unexplained identity conflicts; evidence-based splits retain original history on its identified posting and hold ambiguous screening for review.

`applications` and `application_events` are the authoritative model. Website edits and extension receipts use typed, per-record operations. Executed attempts and official confirmations both leave the unsubmitted queue, with distinct evidence and counts. Failed or uncertain submissions stay held. The plugin owns normal application records; agent operation rules are in [AGENTS.md](../../AGENTS.md).

Profiles use [one JSON Schema](jobs_radar/profile.schema.json), generated types/validation, versioned server storage and REST routes. `get_profiles` provides read-only facts without credentials or attachment bytes. Rules and asynchronous AI jobs share [the answer policy](jobs_radar/answer-policy.json); screening uses [the screening policy](jobs_radar/screening-policy.json).

MCP discovery is authoritative. Tools cover job search/status, application reads and evidence-based corrections, recruiting progress, screening, Profile facts and diagnostics. Optional browser tools expose content-free inventory, requested snapshots and commands guarded by document/version checks. There is no agent job-claim or lease workflow. Protocol 2 is required for mutating extension and website requests; old clients receive an upgrade error.

Redacted diagnostics upload independently from remote observation. Ordinary history has a 30-day retention and 2,000-run capacity; unresolved cases remain pinned until verified resolution. Migration evidence and recovery points are outside ordinary cleanup.

## Authentication

OAuth supports dynamic client registration, authorization code with PKCE S256, resource-bound tokens, refresh rotation and revocation. Tools independently enforce `jobs:read` and `applications:write`. New clients require approval of the exact pending request, redirect and scopes. Never print credentials or tokens or place them in source, Profiles or diagnostics.

The private website uses its own approved session. Production binds to `127.0.0.1:8796` behind the existing Cloudflare Tunnel. Public health and discovery expose no owner records.

## Build, validate and release

```sh
python -m venv .venv
.venv/bin/pip install -r requirements-audit.txt
.venv/bin/python -m pytest tests -q
cd web
npm ci
npm test
npm run build
```

On Windows use `.venv/Scripts/python.exe` and a workspace-local pytest `--basetemp` when the system temporary directory is restricted. Local full-suite validation includes the recovery-content auditor and its pinned PDF parser in `requirements-audit.txt`; production continues to install only `requirements-lock.txt`. Linux process/resource tests need a separate bounded Linux environment, and an environment skip is not a pass. Docker compiles the service and website from the same committed tree. Static output is generated from `web/`, not reused from the running host. Plugin builds are a separate artifact whose loaded version must be verified.

Use only committed [release.sh](deploy/release.sh): `--build` builds exact archived source on the fixed local WSL Docker Desktop engine, `--rehearse` uses local synthetic data, and `release --artifact <directory>` verifies and imports that artifact before switching production. `release --image-id sha256:<64 hex>` accepts an already verified image of the exact commit; `--rollback` uses a compatible recorded image/archive pair. Production build, import-smoke and rehearsal paths are disabled. See [the release contract](deploy/RELEASE.md). Do not copy individual service files to production. The driver pauses writers, verifies database/attachment backup, previews migration, applies it transactionally and checks the matching website. Startup probes have no network or published ports. Failures before public startup can restore matching code/data; once public startup is issued, failures stop the service and preserve possible new writes for review.

The pre-v2 image cannot read the new schema. Its [offline recovery procedure](deploy/LEGACY_RECOVERY.md) preserves a complete current backup and checks old-code reads and non-application writes on a disposable projection. This is not a full online rollback. Do not expose the projection publicly or restart automatic applications from it.

Website-only changes have an independent release path in the same repository:
on Windows run `./services/jobs-radar/deploy/web.ps1 Build` from the repository
root, then `Release -Artifact <directory>` to publish that tested artifact.
`Status` reads the running version and `Rollback` restores the previous website.
After one full service release enables this path, frontend releases do not
rebuild Docker, restart the backend or touch the database. See
[independent website releases](deploy/RELEASE.md#independent-website-releases)
for compatibility and recovery behavior.

## Backup and recovery

Database backups stay on the existing server under its current rotation policy. Explicit migration snapshots are outside that rotation. `deploy/verify_restore.py` checks SQLite integrity, every table fingerprint and embedded attachments in an isolated restore. `deploy/restore_release.py` requires a maintenance boundary. Never overwrite an active SQLite database or discard post-release writes to restore an old image.

Workspace originals and complete Git history require a separately verified, credential-free controlled backup before personal-data cleanup. Database backup does not cover originals not yet stored on the server. Private GitHub code backup follows personal-data and secret checks of all pushed history.
