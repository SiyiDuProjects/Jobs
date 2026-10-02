# Release an identified image

`release.sh` remains the only build/rehearsal/production release entrypoint.
Production never builds an image or runs import smoke or a rehearsal. Local
build and rehearsal modes never contact SSH.

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
`--rollback-web`. SSH uses `JOBS_RADAR_HOST` and `JOBS_RADAR_KEY`, defaulting to
the existing host and `~/.ssh/Siyi.pem`. Credentials never enter artifacts.
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
metadata. Restricted recovery keeps the pinned bundled website and disables
independent publication while that recovery server is active.

## Local build and rehearsal

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
The local build/rehearsal lock prevents parallel auxiliary tasks. Unresolved
earlier builder/container receipts block another run; absent listings never erase
pending creation receipts. Cleanup uses the full verified container ID and its
observed unique cache volume, retaining the receipt.

Output goes under the ignored workspace `.qa/releases/` directory. A completed
manifest records full commit, source archive SHA-256, full image ID and image
archive SHA-256. The image also carries full commit and source archive hash labels.
`--build` creates an artifact; it does not certify a real website flow or deploy it.

```text
bash services/jobs-radar/deploy/release.sh --rehearse --artifact <local-artifact-directory> --old-image sha256:<64 hex>
```

Fault rehearsal currently requires WSL and its native Linux filesystem semantics;
macOS supports building and releasing, but does not run this filesystem rehearsal.
Rehearsal additionally requires the old image already present on the same local
Desktop engine. It uses synthetic data under `.qa/jobs-radar-stage/rehearsal-*`,
unique image/container names, no ports or Docker network, and no host timers. It
preserves archives and reports. Missing images or unresolved old cleanup block
execution; there is no production fallback or automatic image download from it.

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
