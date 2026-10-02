# Real Docker transaction rehearsal

This implementation uses only committed release source. It never
uses the live directory, production Compose project, production image tags,
system timers, host ports, cloud APIs or real owner data.

The supported entrypoint runs locally through the existing WSL Docker Desktop
engine: `release.sh --rehearse --artifact <verified-local-artifact> --old-image
sha256:<full-id>`. Both images must already exist locally. Native Windows and
production hosts are rejected; no remote build, import smoke or rehearsal runs.
The local build/rehearsal task lock is shared with `--build`; unresolved cleanup
from an earlier task blocks another run. See [RELEASE.md](RELEASE.md) for the
source/image identity checks and public-startup failure boundary. Direct use of
`rehearse_docker.py` remains blocked. There is no remote-builder environment
override. The shared production host has only 2 CPU / 2 GiB RAM; helper limits do
not establish that it has enough headroom for additional workloads.

It creates `rehearsal-<random>` with independent image tags and a complete private
Compose config. Containers use `network_mode: none` without published ports or
production secret mounts. The unchanged production defaults of
`switch_release.sh` remain `jobs-radar`, host verification and timer management.
Test overrides are accepted only together, with the random namespace bound to
the resolved rehearsal root, code/data/archive paths and normalized Compose
configuration. Setting timer management off alone is rejected before mutation.

The actual driver runs real Docker, SQLite migration/backup, rsync, tar and HTTP
checks inside containers. A private wrapper injects one failure at backup,
dry-run, committed migration, replaced code, or private image probe; every other
command reaches the real binary. Each failure must restore matching image,
website and database. Then a successful first migration must refuse an
incompatible old-image rollback without changes. Synthetic post-migration
Profile, confirmed/unknown application, setting, new authorization and revocation
writes must survive a second compatible release and rollback.

Logs, database/code backups, per-scenario working directories and the report stay
under the rehearsal archive. Cleanup only removes container IDs recorded as
created by this run, after rechecking their exact names and full IDs. Image tags
and archive evidence remain. Failures stop the rehearsal and retain evidence.

`release_helpers.py` writes and fsyncs an ownership intent before Docker creates
a helper/probe, then records its full container ID. Linux parent directories are
also fsynced after each atomic ledger replacement. Ledgers contain only identity
and phase metadata, never command arguments or environment values. Cleanup checks
ID, exact name and the random ownership label; an uncertain or changed identity
stays available for review. The Linux command runner terminates the whole CLI
process group on timeout, and container cleanup has its own bounded calls.
Combined stdout/stderr capture is capped at 1 MiB with bounded chunk queues.
Exceeding the limit terminates the command and follows the same cleanup path;
large private reports must be saved to their intended files rather than stdout.

Auxiliary containers have provisional hard caps of 512 MiB, 0.5 CPU and 128 PIDs;
migration/backup helpers currently allow up to 768 MiB. Extra swap is disabled.
These are upper bounds, not measured safe budgets for the shared host. The
compatible image variant uses a never-started owned clone and a commit, so this
rehearsal no longer starts an additional BuildKit build worker.

For migration accounting, review `reconcile_application_migration_stream.py`.
The original `reconcile_application_migration.py` is retained for incident
traceability and must not be rerun on large snapshots: it materializes revision
tables. The streamed variant filters inventory revisions in SQL, hashes one
archived/private row at a time, and keeps digest counters on adjacent temporary
disk. Its local equivalence and memory tests do not establish a safe real-host
execution budget or a completed production accounting result.

Local command stand-ins and guard tests are separate from this real-Docker
result. A successful report proves the synthetic isolated scenarios only, not a
production switch or a full cross-schema online rollback. The latter remains the
separate first-migration recovery boundary described in `LEGACY_RECOVERY.md`.
