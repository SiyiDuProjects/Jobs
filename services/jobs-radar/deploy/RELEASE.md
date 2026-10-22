# Release an identified image

`release.sh` remains the only build/production release entrypoint.
Production never builds an image. Local builds never contact SSH.

## Private question corpus

The authenticated `/api/extension/corpus` endpoint accepts bounded inert form
trees, probes existing fingerprints, and exports compressed stored pages as JSON.
Search terms are private owner data. No corpus export, database, report or
independent annotation belongs in Git or ordinary diagnostics.

The collector is additive: it leaves the current answer engine and verifier in
place so its behavior can be measured before the planned answer-engine changes.
Publishing this collector, reading server data and running real applications
follow the task's separate authorization boundaries.

After an authorized export, run from the service directory:

```sh
python -m deploy.question_corpus export --database <existing-database> --output .qa/corpus/pages.json
python -m deploy.question_corpus baseline --input .qa/corpus/pages.json --output .qa/corpus/service-before.json
```

The baseline uses only fictional identities. It uses cached mappings by default;
`--live` explicitly enables the existing provider on the server for unhandled
questions. `--limit` bounds distinct questions (default 30). A live run also saves
`service-before.corpus.json` with new mappings for subsequent offline replay.
Unknown job countries stay unknown. Provider failures are reported separately
from unanswered questions. Draft wording/entities still need independent review.

Use `python -m deploy.question_corpus label --database <existing-database>
--input .qa/corpus/annotation.json` only for an independently reviewed mapping.
The annotation contains `questionId`, `binding` and `meaning`, never the person's
answer. A review-card correction records only a question reference and count.

Copy an authorized export to the extension's `.qa/corpus/pages.json`, then run
`npm run corpus:test`. `node scripts/corpus.mjs test .qa/corpus/pages.json
.qa/corpus/after.json .qa/corpus/before.json` also compares answers/readings.
`npm run corpus:seed` generates explicitly synthetic bootstrap pages; those are
implementation checks, not a real-page baseline. `npm test` and `npm run update`
include the available local corpus. Reports distinguish missing controls,
unrecognized questions, truncated captures, unrecorded searches, invariant
failures and independent mapping accuracy (unavailable without labels).

After a week of authorized collection, inspect compressed table size and search
novelty before changing retention. The collector does not prune existing data.

## Independent website releases

The repository stays together. Website-only changes have their own immutable
artifact and atomic activation; they do not stop Docker, pause collectors, read
SQLite, create database backups, or run migrations. API, MCP and login routes
stay on the same domain. A complete service image still contains a matching
website baseline for bootstrap, recovery and backend changes.

On Windows, use Git for Windows and Node.js directly, without WSL or Docker:

```powershell
# Local tests and build only; prints the saved artifact directory.
.\services\jobs-radar\deploy\web.ps1 Build
# Check compatibility, test/build, publish and verify in one command.
.\services\jobs-radar\deploy\web.ps1 Release
# Publish a previously tested artifact without rebuilding.
.\services\jobs-radar\deploy\web.ps1 Release -Artifact <directory>
.\services\jobs-radar\deploy\web.ps1 Status
.\services\jobs-radar\deploy\web.ps1 Rollback
```

The wrapper dispatches through `release.sh`. Portable entrypoints are
`--build-web`, `--release-web [--artifact <directory>]`, `--web-status`, and
`--rollback-web`. SSH requires an explicit `JOBS_RADAR_HOST` from local deployment configuration.
`JOBS_RADAR_KEY` defaults to `~/.ssh/Siyi.pem`. Credentials never enter artifacts.

On the restored Mac, the migration key is
`/Users/siyi/Projects/_private/Keys/Siyi.pem`. Set
`JOBS_RADAR_KEY=/Users/siyi/Projects/_private/Keys/Siyi.pem` when invoking an
authorized SSH/release task. The migration does not add this identity to the
SSH agent or move it into `~/.ssh`; an empty agent is not evidence of a missing
private-key file. Set `JOBS_RADAR_HOST` to the authorized SSH destination recorded
in the private workspace instructions; public deployment code has no host default.
Builds archive the exact committed service tree, install locked dependencies,
run website tests, build, and check the packaged entrypoints. The service tree
must be clean; use an isolated checkout for unrelated work in progress.
Generated files stay in `.qa/web-releases/`.

**One-time enablement:** publish one normal committed service release containing
these changes. That installs the frontend driver, creates `.web/releases/` and
mounts the store read-only into the service. Before this, `Release` fails its
read-only preflight with an enablement message; it never silently falls back to
a full deployment. Local `Build` works before enablement.

Every artifact records its source commit, file hashes and a conservative backend
fingerprint: runtime Python/JSON, configuration JSON, shared JS contracts, and
Python dependency/package declarations. Changes to any of these require a matching
full service release first. Pure `web/` edits can publish independently. The fence
rejects even compatible backend edits until that service is installed; it does
not infer compatibility from an unchanged protocol number. Generated Profile and
response contracts therefore match the running service.

The server accepts only complete bounded static archives with verified hashes.
Publication shares the full-release locks, installs an immutable directory,
atomically switches `state.json`, and verifies the live page, management page,
exact JS/CSS bytes and backend health. Failed verification restores the prior
pointer. The first independent release can roll back to the bundled website.
A full backend upgrade/rollback selects its own bundled baseline when the
external website is incompatible.

Page entries are not cached. Old versioned resources remain available, so an
already-open page cannot receive another version's JS/CSS. Bundles are retained;
these commands do not prune old versions or delete data. The public
`/.well-known/jobs-web-release` endpoint exposes only compatibility/version
metadata.

## Local build

Run from macOS or WSL connected to this machine's Docker Desktop. On Mac,
install and start Docker Desktop; the entrypoint also discovers its bundled CLI
when `docker` is not on PATH. Assign at least 8 GiB of usable engine memory
(10 GiB in Desktop settings leaves room for VM overhead).

```text
bash services/jobs-radar/deploy/release.sh --build
```

The entrypoint requires a clean committed service tree. On Mac it checks the
`desktop-linux` context endpoint is `unix://$HOME/.docker/run/docker.sock`; on WSL,
the fixed `default` endpoint is `unix:///var/run/docker.sock`. The engine must
identify as Linux `docker-desktop`, with at least 8 GiB of usable memory.
Native Windows builds are blocked because Windows process-tree termination has
not been established; macOS and Linux CLI process groups have bounded deadlines/output.
Builder redirection environment variables are rejected. No user Docker context
or settings are changed: every run gets a private empty CLI config and a unique
context connected to the verified endpoint. Registry credentials, proxy config,
SSH credentials and secret mounts are not supplied to BuildKit.

Source enters the build context from a Git archive of the exact committed service tree.
The licensed website package under ignored `web/vendor/` is copied separately
only after its bytes match the SHA-512 integrity in that archive's npm lockfile.
It is not committed, and its integrity is recorded in the artifact manifest.
Missing, changed or linked packages stop the build before BuildKit starts.
The archive rejects private-data directories, environment/credential filenames,
database files and links, including accidental commits. This filename guard is
not a complete audit of source-file contents. Builds use an explicitly selected,
temporary BuildKit container with a verified 2 CPU / 4 GiB budget and no additional
swap. Both Intel and Apple Silicon hosts build `linux/amd64` for production.
The local build lock prevents parallel auxiliary tasks. Unresolved
earlier builder/container receipts block another run; absent listings never erase
pending creation receipts. Cleanup uses the full verified container ID and its
observed unique cache volume, retaining the receipt.

Output goes under the ignored workspace `.qa/releases/` directory. A completed
manifest records full commit, source archive SHA-256, full image ID and image
archive SHA-256. The image also carries full commit and source archive hash labels.
`--build` creates an artifact; it does not certify a real website flow or deploy it.

The one-time migration/recovery runners have been retired. The release validator
requires applications-v2, native-extension-submission-reporting-v1 and
diagnostics-v2-2026-09-26 completion markers and checks active Profiles and SQLite
integrity in an isolated dry run before the maintenance-protected final check.
A populated legacy database must first pass the archived migration release;
this release does not rerun old repairs. Backup and compatible rollback remain
part of the ordinary release transaction.

## Import and release

```text
bash services/jobs-radar/deploy/release.sh release --artifact <local-artifact-directory>
```

Set `JOBS_RADAR_KEY` to the existing SSH private-key path if it differs from
`$HOME/.ssh/Siyi.pem`; `JOBS_RADAR_HOST` overrides the deployment host. Local SSH
transfers use a Python process-group deadline with streamed input/output, so Mac
does not require GNU `timeout`. Noninteractive SSH failures propagate unchanged.

The local artifact must still match the current exact committed source. Transfer
checks source/image archive hashes. Before Docker load, the importer requires a
single image with no repository tags, safe archive paths, configuration bytes
whose digest is the full image ID, and matching commit/source labels. This keeps
loading from changing an active release tag. Import holds the same host/live locks
as the switch driver and admin database gate; Docker load has bounded output and a
deadline. Post-load identity is checked again before assigning the commit tag.
Existing different images for that commit are rejected. Import starts no service,
build worker or smoke container. It does not change production runtime resources.

After a separate build has been verified and its exact image already exists on
the target host, release only its matching committed source:

```text
bash services/jobs-radar/deploy/release.sh release --image-id sha256:<64 hex characters>
```

The argument is the complete Docker image `.Id`, not a tag. The entrypoint
requires a clean committed service tree, resolves the release abbreviation to
the full current commit, then uses read-only image inspection to verify:

- The supplied immutable image ID exists and is returned unchanged.
- Its `release` label is the current commit abbreviation.
- `jobs-radar:<commit>` resolves to that exact image ID.

Mismatch stops before source upload, service pause or container creation. No
older candidate is accepted as the image for newer source. The transaction
driver rechecks the candidate identity under its locks before changing state.
Container source labels are an identity check, not a substitute for a reviewed
build origin and build validation.

Default invocation without an explicit artifact or image ID is blocked. There is
no production-build fallback.

## Compatible rollback

```text
bash services/jobs-radar/deploy/release.sh --rollback
```

Rollback uses the recorded previous release, not the current checkout's HEAD or
a new `--image-id`. Each completed release records the previous commit, source
archive path, full previous image ID and archive SHA-256. Rollback requires all
four to agree, including the archive's `RELEASE`, then checks data compatibility.
Post-release data is retained during a compatible rollback. A legacy two-line
record lacks the recorded identity proof and needs separate review; it is never
silently upgraded or accepted as a verified pair.

The public startup command is the boundary after which new writes may exist,
even when Compose returns an error or times out. Any subsequent failure stops
the service and keeps the database and maintenance marker for review; it never
restores the pre-release snapshot. Before that boundary, failure can restore the
verified matching code and database. A different image for the currently active
commit is rejected before tags or data can change.

The transaction holds a fixed host release lock, followed by the existing
`$LIVE/.release.lock` shared with admin database operations. It retains both
through backup, migration, activation and recovery. Helper/probe containers have
bounded resources and verified cleanup. These auxiliary budgets do not alter
the production service's normal Compose startup resources and do not establish
that the shared host has sufficient spare memory.

Every Docker daemon call in the switch driver has a deadline and an output
budget, including Compose and `exec`. A timed-out create without a confirmed
container ID remains pending in the durable cleanup ledger. An empty container
list cannot prove that the daemon will not finish that create later. Pending
receipts block another release and background writer resumption; later cleanup
retries the exact name and ownership label, then records the full verified ID.

## Release retention

Every release writes a full pre-change database copy, a code archive, a staged
source tree, an import folder and a commit image tag. Daily backups keep three
(`prune_backups.py`); these per-release copies are bounded by
`prune_releases.py`, which a completed release runs under its locks after the
new rollback pair is recorded. Failed releases and rollbacks remove nothing.

Kept: the live release and its recorded rollback commit (stage, image tag and
code archive), the two newest pre-change database copies (each verified before
anything older is removed), the two newest code archives and per-run scratch
records, and any stage/import folder or its commit image modified within the
last hour (a concurrent release). Migration reports stay. Images are never
force-removed, so a tag used by any container remains. Website bundles,
scheduled backups and every name not written by the release scripts are only
listed under `unmanaged` for a separate decision.

```text
bash services/jobs-radar/deploy/release.sh --prune           # dry run, JSON plan
bash services/jobs-radar/deploy/release.sh --prune --apply   # committed rules only
```

The rules travel over stdin under the same host/live locks, so a disk too full
for the next release's capacity preflight can be recovered without first
installing a release. A failed capacity preflight points here.

## Lazy assets and release check receipts

Website bundles now enumerate their generated chunks, hash every file and pin
entry URLs to `/assets/<version>/board.js`. Relative lazy imports retain that
version after another website is activated or rolled back. The server accepts
older four-file/query-string bundles so existing website rollback records stay
usable. Archives reject unlisted members, duplicates, links and path traversal;
activation verifies every listed asset over HTTP before keeping the switch.

Full service builds first check an isolated archive of the exact commit, including
extension and repository-script fixtures consumed by the service tests. The
check stage installs locked Node dependencies only in that disposable directory,
runs website tests/build/artifact validation and the full service pytest suite,
and refuses source changes during validation. Python uses `JOBS_BUILD_PYTHON`,
the existing service `.venv`, or the invoking Python in that order; pytest must
already be available. No private corpus or credentials enter the archive.
A missing optional corpus remains an explicit skipped test, not acceptance.

The manifest records the passing checks, exact test-input/archive hashes and
source commit. The image label `jobs.tests.sha256` binds the receipt to that image;
local verification and import validate it. Explicit `--image-id` releases require
this label and the full source commit. Failed checks produce no publishable
manifest or image. Existing recorded rollback images remain usable.

For local capacity review, run:

```sh
python3 services/jobs-radar/deploy/local_retention.py
```

This is an inventory only, with no deletion mode. Keep the current/previous
artifacts, unfinished builder receipts, worktree recovery archives and unresolved
bug evidence. Older build directories are review candidates only: establish
that no rollback or unresolved-case reference depends on them before removal.
Do not treat `.qa/` as a disposable cache. Server retention remains the separate
locked `release.sh --prune` workflow.

The compressed management-history storage contract is `zlib-sha256-v1`.
Forward readers still accept older plain JSON revisions. Once compressed
references have been written, rollback to an image that only understands plain
JSON is incompatible and the normal contract comparison must refuse it; do not
bypass that check. Retain the pre-upgrade backup for an explicitly planned
restore if such a downgrade is ever required.
