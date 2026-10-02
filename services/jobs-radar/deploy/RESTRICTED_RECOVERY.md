# Restricted recovery mode

This is the owner-approved temporary **Profile/settings recovery mode**, not a
claim that the previous application's complete runtime can safely read or write
v2. The old image stays offline. `recover_legacy.py` remains an offline evidence
tool and its `candidate.sqlite` must never be used as the public database.

The restricted server uses the verified v2-compatible image and its packaged
website. It preserves the complete latest v2 database, including attempted,
unconfirmed, deleted, external and owner-held application rows, all events and
receipts. Only the owner website's Profile, saved responses and settings can
write. Every other HTTP route, including MCP, extension Profile grants, AI,
control, receipts, old protocols and future unknown routes, returns HTTP 503
with `code=recovery_application_pause`. There is no application worker startup.

## Activation contract for the release driver

The release driver owns all real operations. It must first keep the normal
`.release-maintenance` flag, stop timers/collectors and all old service containers,
and stop browser runs with acknowledged page shutdown. Already-dispatched ATS
network requests cannot be recalled: uncertain submission state remains held.
Receipt outboxes and duplicate-submission guards must not be cleared. Legacy
clients that cannot acknowledge the dedicated pause signal must be stopped
explicitly before this mode is declared active.

Use an immutable image ID already verified to contain these recovery modules
and the matching website. Never substitute an old image or a mutable tag. With
all writers stopped, run the packaged helper in that image:

```text
python /app/deploy/prepare_restricted_recovery.py prepare
  --current /data/jobs.sqlite
  --bundle /data/migrations/restricted-<12-to-64-lowercase-hex>
  --release <verified-commit>
  --image-id sha256:<verified-image-id>
```

Arguments are ordinary separate arguments; line breaks above are documentation.
The helper refuses an existing bundle, an unsupported schema, insufficient
space, a missing packaged website, and an unverified identity format. It does
not independently discover Docker identity: the driver must inspect and supply
the pinned image ID. The bundle contains:

- `current-v2.sqlite`: complete sealed baseline, never used for recovery writes.
- `recovery.sqlite`: complete v2 copy with every non-Profile/settings table
  guarded and old browser execution cancelled/held, without deleting its proof.
- `manifest.json`: release/image identity, source/web hashes, whole-table hashes
  and actual restore comparison, containing no private row values.

Files use 0600 and the new directory uses 0700 on Linux. Copies/hash checks are
bounded and streamed. Preparation failure retains originals and writes `FAILED`;
the server refuses that bundle. A 2 GiB database limit is a disk-size ceiling,
not a memory-safety claim for arbitrary provider/browser work.

After preparation completes, with the service stopped and global maintenance
still present, publish the strictly scoped activation marker using the same
verified image:

```text
python /app/deploy/prepare_restricted_recovery.py write-marker
  --current /data/jobs.sqlite
  --bundle /data/migrations/restricted-<12-to-64-lowercase-hex>
  --release <verified-commit>
  --image-id sha256:<verified-image-id>
```

Keep Compose and credential environment files unchanged. The normal
`python -m jobs_radar.cli serve` checks `/data/.restricted-recovery.json` **before
opening the normal Store** and dispatches to the independent recovery ASGI
service. Without the marker its behavior is unchanged. The marker is bounded to
4 KiB, rejects duplicate keys and unknown fields, permits only the directory
above, and verifies manifest hash, identity and runtime/web hashes. Symlinks,
bad metadata, missing guards and runtime mismatch fail closed without starting
the ordinary server. The release driver verifies the actual Docker image label
and immutable ID; no Docker socket or new credential is mounted into the service.

Keep normal `JOBS_HOST`, `JOBS_PORT`, `JOBS_DB` and owner origin. Publish only its
usual loopback-facing port after an isolated probe. `/healthz` must report
`mode=restricted-profile-settings`, `applicationWrites=paused` and the expected
release. `/` opens the existing website at Profile; its visible banner says
applications are paused. Probe actual `/manage/` and both `/assets/board.*` assets;
normal MCP discovery is intentionally unavailable. Existing owner website
sessions remain valid. New website sign-ins are approved using the same image:

```text
python -m jobs_radar.cli approve-web <request-id>
```

The global release-maintenance marker stays in place. Only this independent
server has its own `.pause-profile-writes` marker inside the bundle; it cannot
unpause the normal application service. Bearer/device grants are never accepted
as recovery website authorization. Profile/settings writes retain protocol,
origin, validation and optimistic-version checks. Saved responses use the existing
normalizer and require an existing Profile. Application list display is read-only.

## Leaving recovery without losing edits

Create `<bundle>/.pause-profile-writes`, stop the recovery container and wait for
it to exit. An OS lifetime lock prevents exporting while it still runs. Then:

```text
python /app/deploy/prepare_restricted_recovery.py export-resume
  --bundle /data/migrations/restricted-<12-to-64-lowercase-hex>
```

The helper rechecks frozen tables, copies the **latest active recovery database**,
removes only its verified guards, checks all data again, and atomically publishes
`resume-v2.sqlite` and its `resume-report.json`. Failed copies/checks leave only a
`.partial` file; report-publication failure cannot authorize marker removal.
All originals remain. Never use a standalone database file without its report.
Never reactivate `current-v2.sqlite`: that would lose Profile/settings
edits made during recovery. Never overwrite an existing resume export.

The release driver must use the new complete `resume-v2.sqlite` as the next
normal v2 database under its ordinary backup/probe/activation transaction. While
the service is still stopped, promote it to `/data/jobs.sqlite` and run:

```text
python /app/deploy/prepare_restricted_recovery.py clear-marker
  --current /data/jobs.sqlite
```

This compares the complete promoted database to the exact latest resume proof,
verifies its file hash and identity, requires both pause markers and the stopped
server lock, and only then removes the recovery marker. It refuses the old
snapshot and leaves global maintenance in place. Probe the ordinary service
before clearing that global pause. Keep
the bundle under the controlled backup policy. Do not restart applications or
timers until the compatible service and plugin pass normal readiness checks.
Held submissions require reconciliation, not another submission.

## Local acceptance

Preparation/export/marker-clear accept `--timeout` (default 120, maximum 300
seconds), with explicit copy/hash/SQL checkpoints. SQLite also enforces a 16 MiB
row limit before Python materializes historical rows; a larger old row blocks
activation with the complete source/snapshot retained, without truncation.
These are fail-closed budgets,
not a claim that an 815 MiB real archive finishes within that time or fits the
shared production host. Large-data acceptance under the actual resource cap is
required before a real activation; keep the complete source on any timeout.
`tests/restricted_recovery_scale.py --work <new-private-dir> --size-mib 815
--timeout 300` generates only synthetic historical values and exercises the full
prepare/export path. Run it only under an explicitly imposed OS/container cap;
its Python allocation measurement alone is not an OS memory-cap proof.

On 2026-09-26 this path completed against a 856,100,864-byte synthetic database
on the local Linux Docker Desktop engine. The inspected container had 512 MiB
memory and swap ceilings, 0.5 CPU, 128 PIDs and no network. Preparation took
18.491 seconds and latest-data export took 16.987 seconds; maximum resident
memory was 82,264 KiB. All-table restore comparison passed. Evidence is
`.qa/recovery-scale-a8f12bc2c870432f890cfd8c9cba37da/` at the workspace root,
including exact source hashes and removal receipts for the owned containers
and synthetic data volume. This is synthetic size/resource acceptance; the
real migration's independent data-conflict audit is still a release gate.

The release entry points are `release.sh --recover-profiles --image-id <full-id>`
and `release.sh --resume-applications --image-id <full-id>`. They require the
committed driver, live release and published image to match. The final local
driver regression result was 81 passed with one Windows-only skip; independent
review reproduced and fixed maintenance probes expecting 401 instead of 503,
and host traversal of a 10001-owned private data directory. Normal probes stay
under maintenance until activation checks finish, then check ordinary 401 before
timers resume. Database metadata checks run as the data owner without relaxing
directory permissions. A complete candidate-image Docker transaction and real
installation acceptance remain separate checks.

`tests/test_restricted_recovery.py` uses real ASGI requests, domain writes and
SQLite triggers/authorizer over synthetic v2 fixtures. It covers current/old/
unknown route denial, origin/protocol/cookie boundaries, global maintenance,
Profile/settings/saved-response edits, all protected tables, stalled or incomplete
preparation/export, runtime drift, and recovery edits retained on export.

`tests/restricted_recovery_browser.py` runs the existing packaged website in an
isolated Chromium context against a loopback ASGI server. It saves/reloads a
synthetic Profile and settings, verifies their persisted database values and
unchanged application fingerprints, and closes its browser/server. This is local
synthetic acceptance, not a production cutover or an old-runtime acceptance claim.
