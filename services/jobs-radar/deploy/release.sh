#!/bin/bash
# Release committed source using an explicitly identified prebuilt image.
# Builds use only the fixed local Docker Desktop engine; production never builds.
set -euo pipefail
HOST=${JOBS_RADAR_HOST:-ubuntu@49.51.38.235}
KEY=${JOBS_RADAR_KEY:-$HOME/.ssh/Siyi.pem}
LIVE=/home/ubuntu/siyi/jobs-radar
STAGE_ROOT=/home/ubuntu/siyi/jobs-radar-stage
ARCHIVE=/home/ubuntu/siyi/jobs-radar-archive
MODE=${1:-release}
if [ "$#" -gt 0 ]; then shift; fi
ENTRY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
remote() { timeout --signal=TERM --kill-after=5s 3600s ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -i "$KEY" "$HOST" "$@"; }
case "$MODE" in --build-web|--release-web|--rollback-web|--web-status)
  exec node "$ENTRY_DIR/web_release.mjs" "$MODE" "$@";;
esac
case "$MODE" in release|--build|--rollback|--rehearse|--recover-profiles|--resume-applications) ;; *) echo 'Unknown release mode' >&2; exit 2;; esac
if [ "$MODE" = --rehearse ]; then
  exec python3 "$ENTRY_DIR/local_rehearsal.py" "$@"
fi
if [ "$MODE" = --build ]; then
  [ "$#" = 0 ] || { echo 'Local builds accept no host or builder overrides.' >&2; exit 2; }
  exec python3 "$ENTRY_DIR/local_build.py" build
fi

if [ "$MODE" = --rollback ]; then
  [ "$#" = 0 ] || { echo 'Rollback uses its recorded image/archive; no candidate arguments are accepted.' >&2; exit 2; }
  # The last committed release installed its matching transaction driver.
  remote bash "$LIVE/deploy/switch_release.sh" --rollback "$LIVE" "$STAGE_ROOT/rollback" "$ARCHIVE"
  exit $?
fi
ARTIFACT=
if [[ "$MODE" = --recover-profiles || "$MODE" = --resume-applications ]]; then
  [ "$#" = 2 ] && [ "$1" = --image-id ] || { echo 'Recovery requires the already published immutable --image-id; artifact imports are not accepted.' >&2; exit 2; }
fi
if [ "$#" = 2 ] && [ "$1" = --artifact ]; then
  ARTIFACT=$(cd "$2" && pwd)
  IMAGE_ID=$(python3 "$ENTRY_DIR/local_build.py" verify --artifact "$ARTIFACT")
elif [ "$#" = 2 ] && [ "$1" = --image-id ] && [[ "$2" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  IMAGE_ID=$2
else
  echo 'Release requires --artifact <local build directory> or --image-id sha256:<64 hex> for exact committed source. No production image will be built.' >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- services/jobs-radar)" ]; then
  echo 'services/jobs-radar has uncommitted changes; commit them first.' >&2
  exit 1
fi
SHA=$(git rev-parse --short=12 HEAD)
FULL_SHA=$(git rev-parse HEAD)
[ "$(git rev-parse --verify "$SHA^{commit}")" = "$FULL_SHA" ] || { echo 'Commit abbreviation is ambiguous.' >&2; exit 1; }
STAGE=$STAGE_ROOT/$SHA
if [ -n "$ARTIFACT" ]; then
  IMPORT=$STAGE_ROOT/import-$FULL_SHA-$(python3 -c 'import secrets;print(secrets.token_hex(6))')
  # Transfer data only; production runs the importer from committed source.
  remote "umask 077; mkdir -p $IMPORT $STAGE"
  for file in source.tar image.tar manifest.json; do
    remote "umask 077; cat > $IMPORT/$file" < "$ARTIFACT/$file"
  done
  SOURCE_SHA=$(sha256sum < "$ARTIFACT/source.tar" | awk '{print $1}')
  remote bash -s -- "$IMPORT/source.tar" "$SOURCE_SHA" "$STAGE" <<'SOURCE'
set -euo pipefail
[ "$(sha256sum < "$1" | awk '{print $1}')" = "$2" ] || { echo 'Transferred source archive changed' >&2; exit 1; }
tar -xf "$1" -C "$3"
SOURCE
  IMPORTED=$(remote python3 "$STAGE/deploy/import_image.py" --folder "$IMPORT" --commit "$FULL_SHA")
  [ "$IMPORTED" = "$IMAGE_ID" ] || { echo 'Imported image identity differs' >&2; exit 1; }
fi
# After any verified artifact import, check activation identity before copying
# release source again, pausing the service or creating a candidate container.
remote bash -s -- "$SHA" "$IMAGE_ID" <<'VERIFY'
set -euo pipefail
expected_commit=$1
expected_image=$2
docker() { timeout --signal=TERM --kill-after=5s 30s docker "$@"; }
[ "$(docker image inspect "$expected_image" --format '{{.Id}}')" = "$expected_image" ] || { echo 'Image ID mismatch' >&2; exit 1; }
[ "$(docker image inspect "$expected_image" --format '{{index .Config.Labels "release"}}')" = "$expected_commit" ] || { echo 'Image commit does not match the committed source' >&2; exit 1; }
[ "$(docker image inspect "jobs-radar:$expected_commit" --format '{{.Id}}')" = "$expected_image" ] || { echo 'Commit image tag differs from the requested immutable ID' >&2; exit 1; }
VERIFY
echo "Staging $SHA"
# Separate commits never overwrite another release's staged source.
git archive --format=tar "$FULL_SHA" services/jobs-radar |
  remote "mkdir -p $STAGE && tar -x -C $STAGE --strip-components=2"

remote "printf '%s\\n' $SHA > $STAGE/RELEASE"
if [[ "$MODE" = --recover-profiles || "$MODE" = --resume-applications ]]; then
  # This driver additionally requires LIVE and its running image to be this
  # same committed release. Recovery never installs another runtime or image.
  remote python3 "$STAGE/deploy/recover_profiles.py" "$MODE" --live "$LIVE" --release "$SHA" --image-id "$IMAGE_ID"
  exit $?
fi
OUTPUT=$(remote bash "$STAGE/deploy/switch_release.sh" "$SHA" "$LIVE" "$STAGE" "$ARCHIVE" "$IMAGE_ID")
echo "$OUTPUT"
grep -q "^Released $SHA " <<<"$OUTPUT" || { echo 'Release did not complete; check the server.' >&2; exit 1; }
