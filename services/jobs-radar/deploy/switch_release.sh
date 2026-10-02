#!/bin/bash
# Server-side transaction. Called only by release.sh with committed source.
set -Eeuo pipefail
umask 077
REQUEST=$1
LIVE=$2
STAGE=$3
ARCHIVE=$4
EXPECTED_IMAGE_ID=${5:-}
IMAGE_PREFIX=${JOBS_RELEASE_IMAGE_PREFIX:-jobs-radar}
PROJECT=${JOBS_RELEASE_COMPOSE_PROJECT:-jobs-radar}
VERIFY_MODE=${JOBS_RELEASE_VERIFY_MODE:-host}
MANAGE_TIMERS=${JOBS_RELEASE_MANAGE_TIMERS:-1}
REHEARSAL_ROOT=${JOBS_RELEASE_REHEARSAL_ROOT:-}
DRIVER_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# A timeout inside urllib does not bound a stalled Docker daemon/CLI. Route
# every daemon call (including Compose and exec) through the bounded wrapper.
docker() {
  local deadline=30
  case "${1:-}" in compose) deadline=180;; exec) deadline=90;; esac
  python3 "$DRIVER_DIR/release_helpers.py" docker-command --timeout "$deadline" -- "$@"
}
if [ "$IMAGE_PREFIX:$PROJECT:$VERIFY_MODE:$MANAGE_TIMERS" != jobs-radar:jobs-radar:host:1 ] || [ -n "$REHEARSAL_ROOT" ]; then
  # No override may silently target production or its shared image tags. The
  # root suffix binds every writable path, Compose project and image namespace.
  ROOT=$(realpath -e "$REHEARSAL_ROOT")
  [[ "$ROOT" =~ /jobs-radar-stage/rehearsal-([a-f0-9]{12,32})$ ]] || { echo 'Invalid isolated rehearsal root' >&2; exit 2; }
  NAMESPACE=jobs-radar-rehearsal-${BASH_REMATCH[1]}
  [ "$IMAGE_PREFIX:$PROJECT:$VERIFY_MODE:$MANAGE_TIMERS" = "$NAMESPACE:$NAMESPACE:container:0" ] || { echo 'Incomplete rehearsal isolation' >&2; exit 2; }
  [ "$(realpath -e "$LIVE")" = "$ROOT/live" ] && [ "$(realpath -e "$ARCHIVE")" = "$ROOT/archive" ] || exit 2
  [[ "$(realpath -e "$STAGE")" = "$ROOT"/stages/* ]] || exit 2
  [ "$(realpath -e "${COMPOSE_FILE:-}")" = "$ROOT/compose.yaml" ] || exit 2
  export COMPOSE_PROJECT_NAME=$PROJECT
  # The isolated Compose file must not mount live data/secrets or publish ports.
  docker compose --project-directory "$LIVE" config --format json | python3 -c '
import json,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve(); namespace=sys.argv[2]; config=json.load(sys.stdin)
assert config.get("name")==namespace and set(config["services"])=={"mcp"}, "Unexpected Compose project/services"
service=config["services"]["mcp"]
assert service["image"]==namespace+":0.1.0" and service.get("network_mode")=="none", "Unexpected image/network"
assert not service.get("ports") and not service.get("secrets") and not service.get("configs"), "Rehearsal exposes external resources"
volumes=service.get("volumes",[])
assert len(volumes)==1 and volumes[0].get("type")=="bind" and Path(volumes[0]["source"]).resolve()==root/"live/data" and volumes[0]["target"]=="/data", "Rehearsal mount escapes its data directory"
assert not service.get("privileged") and not service.get("devices") and not service.get("pid") and not service.get("ipc"), "Unexpected host access"
' "$REHEARSAL_ROOT" "$NAMESPACE" || exit 2
else
  [ -z "${COMPOSE_FILE:-}" ] && [ -z "${COMPOSE_PROJECT_NAME:-}" ] || { echo 'Production Compose overrides require review' >&2; exit 2; }
fi
cd "$LIVE"
# One auxiliary release transaction per host, across rehearsal namespaces.
# Keep the existing live-data lock as the shared admin/release exclusion gate.
HOST_ROOT=$(dirname "$LIVE")
if [ -n "$REHEARSAL_ROOT" ]; then HOST_ROOT=$(dirname "$(dirname "$REHEARSAL_ROOT")"); fi
exec 8>"$HOST_ROOT/.jobs-radar-release-host.lock"
flock -n 8 || { echo 'Another host release/helper transaction is active' >&2; exit 1; }
exec 9>"$LIVE/.release.lock"
flock -n 9 || { echo 'Another release is active' >&2; exit 1; }
# Kept outside code snapshots and database backups; mounted read-only by mcp.
[ ! -L "$LIVE/.web" ] && [ ! -L "$LIVE/.web/releases" ] || { echo 'Website storage must not be a symlink' >&2; exit 1; }
mkdir -p "$LIVE/.web/releases"
chmod 755 "$LIVE/.web" "$LIVE/.web/releases"
HELPER_STATE=${REHEARSAL_ROOT:-$LIVE/.release}/containers
helper_cli() { python3 "$DRIVER_DIR/release_helpers.py" --state "$HELPER_STATE" --namespace "$PROJECT" "$@"; }
# Unresolved creates from an interrupted transaction block another transaction.
helper_cli cleanup

CURRENT=$(docker image inspect "$IMAGE_PREFIX:0.1.0" --format '{{index .Config.Labels "release"}}')
CURRENT_IMAGE_ID=$(docker image inspect "$IMAGE_PREFIX:0.1.0" --format '{{.Id}}')
PREVIOUS_IMAGE=$(docker image inspect "$IMAGE_PREFIX:previous" --format '{{.Id}}' 2>/dev/null || true)
[[ "$CURRENT" =~ ^[a-f0-9]{12,40}$ ]] || { echo 'Current image has no verified release identity' >&2; exit 1; }
[ "$(cat RELEASE)" = "$CURRENT" ] || { echo 'Live code does not match the running image; inspect before releasing.' >&2; exit 1; }
MODE=release
TARGET=$REQUEST
HELPER=$IMAGE_PREFIX:$TARGET
HELPER_ID=$EXPECTED_IMAGE_ID
if [ "$REQUEST" = --rollback ]; then
  MODE=rollback
  [ -f .rollback-target ] || { echo 'No verified rollback target is recorded' >&2; exit 1; }
  mapfile -t ROLLBACK < .rollback-target
  [ "${#ROLLBACK[@]}" = 4 ] || { echo 'Rollback metadata lacks recorded image/archive digests; review the legacy record before recovery.' >&2; exit 1; }
  TARGET=${ROLLBACK[0]}
  TARGET_CODE=${ROLLBACK[1]}
  EXPECTED_IMAGE_ID=${ROLLBACK[2]}
  CODE_DIGEST=${ROLLBACK[3]}
  [[ "$TARGET" =~ ^[a-f0-9]{12,40}$ && "$TARGET_CODE" = "$ARCHIVE"/code-*.tgz && -f "$TARGET_CODE" ]] || exit 1
  [ "$(docker image inspect "$IMAGE_PREFIX:previous" --format '{{index .Config.Labels "release"}}')" = "$TARGET" ] || exit 1
  [[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ && "$CODE_DIGEST" =~ ^[a-f0-9]{64}$ ]] || exit 1
  [ "$PREVIOUS_IMAGE" = "$EXPECTED_IMAGE_ID" ] || { echo 'Recorded rollback image changed' >&2; exit 1; }
  [ "$(sha256sum < "$TARGET_CODE" | awk '{print $1}')" = "$CODE_DIGEST" ] || { echo 'Recorded rollback archive changed' >&2; exit 1; }
  [ "$(tar -xOf "$TARGET_CODE" ./RELEASE)" = "$TARGET" ] || { echo 'Rollback archive belongs to another commit' >&2; exit 1; }
  schema() { helper_cli run --image "$1" --image-id "$2" -- -c 'import importlib.util,json; s=importlib.util.find_spec("jobs_radar.release_compatibility"); print(json.dumps(__import__("jobs_radar.release_compatibility",fromlist=["data_contract"]).data_contract(),sort_keys=True) if s else "pre-contract")'; }
  [ "$(schema "$IMAGE_PREFIX:0.1.0" "$CURRENT_IMAGE_ID")" = "$(schema "$IMAGE_PREFIX:previous" "$PREVIOUS_IMAGE")" ] || {
    echo 'The previous image cannot read this database. Restore/replay must be rehearsed separately; no live image or data changed.' >&2
    exit 1
  }
  HELPER=$IMAGE_PREFIX:$CURRENT
  HELPER_ID=$CURRENT_IMAGE_ID
fi
[[ "$TARGET" =~ ^[a-f0-9]{12,40}$ ]] || exit 1
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'An explicit immutable candidate image ID is required' >&2; exit 1; }
[ "$(docker image inspect "$IMAGE_PREFIX:$TARGET" --format '{{.Id}}')" = "$EXPECTED_IMAGE_ID" ] || { echo 'Candidate image tag changed after preflight' >&2; exit 1; }
[ "$(docker image inspect "$IMAGE_PREFIX:$TARGET" --format '{{index .Config.Labels "release"}}')" = "$TARGET" ] || { echo 'Candidate image commit mismatch' >&2; exit 1; }
if [ "$TARGET" = "$CURRENT" ] && [ "$EXPECTED_IMAGE_ID" != "$CURRENT_IMAGE_ID" ]; then
  echo 'The same commit already identifies a different image; refused immutable release identity change.' >&2
  exit 1
fi
docker tag "$CURRENT_IMAGE_ID" "$IMAGE_PREFIX:$CURRENT"

COLLECT_TIMER=inactive
BACKUP_TIMER=inactive
helper() { helper_cli run --image "$HELPER" --image-id "$HELPER_ID" --memory 768 --mount "$LIVE/data:/data" -- "$@"; }
unit_state() {
  local state status
  if state=$(systemctl is-active "$1"); then status=0; else status=$?; fi
  case "$status:$state" in
    0:active|0:activating|0:reloading|0:deactivating|3:inactive|3:failed|3:deactivating) printf '%s' "$state";;
    *) echo "Cannot establish unit state: $1" >&2; return 2;;
  esac
}
if [ "$MANAGE_TIMERS" = 1 ]; then
  COLLECT_TIMER=$(unit_state jobs-radar-collect.timer)
  BACKUP_TIMER=$(unit_state jobs-radar-backup.timer)
fi
WRITERS_UNCERTAIN=0
resume_timers() {
  [ "$MANAGE_TIMERS" = 1 ] || return 0
  # The host cannot traverse data owned by the container user. Only a successful
  # absence check as that user can resume writers; permission/I/O failures hold.
  if ! helper -c 'from pathlib import Path
try: Path("/data/.release-maintenance").stat()
except FileNotFoundError: pass
else: raise SystemExit("Maintenance remains active")'; then
    echo 'Maintenance is active or unreadable; background writers stay paused for recovery.' >&2
    return
  fi
  [ "$COLLECT_TIMER" != active ] || sudo systemctl start jobs-radar-collect.timer
  [ "$BACKUP_TIMER" != active ] || sudo systemctl start jobs-radar-backup.timer
}
release_exit() {
  helper_cli cleanup || { echo 'Auxiliary container cleanup failed; writers stay paused.' >&2; return 1; }
  [ "$WRITERS_UNCERTAIN" = 0 ] || { echo 'Writer state remains unknown; timers stay paused.' >&2; return 1; }
  resume_timers
}
trap release_exit EXIT
if [ "$MANAGE_TIMERS" = 1 ]; then sudo systemctl stop jobs-radar-collect.timer jobs-radar-backup.timer; fi
# Timers can already have started a unit. Wait for both writers to finish.
writers_busy() {
  [ "$MANAGE_TIMERS" = 1 ] || return 1
  local inventory state
  inventory=$(docker ps --format '{{.Names}}') || return 2
  grep -q "$PROJECT-collector-run" <<<"$inventory" && return 0
  for unit in jobs-radar-collect.service jobs-radar-backup.service; do
    state=$(unit_state "$unit") || return 2
    case "$state" in active|activating|reloading|deactivating) return 0;; esac
  done
  return 1
}
check_writers() {
  local status
  if writers_busy; then return 0; else status=$?; fi
  if [ "$status" != 1 ]; then
    WRITERS_UNCERTAIN=1
    echo 'Cannot confirm background writers are idle; release stopped before database changes.' >&2
    exit 1
  fi
  return 1
}
for i in $(seq 1 90); do check_writers || break; sleep 20; done
if check_writers; then echo 'A writer is still running; aborted before pausing the website.' >&2; exit 1; fi

RUN=$TARGET-$(date -u +%Y%m%dT%H%M%SZ)-$$
RECOVERY=/data/migrations/$RUN
CODE_BACKUP=$ARCHIVE/code-$CURRENT-$RUN.tgz
mkdir -p "$ARCHIVE"
helper -c 'from pathlib import Path; p=Path("/data/.release-maintenance"); assert not p.exists(), "An interrupted release needs review"; p.write_text("release in progress")'
BACKED_UP=0
CHANGED=0
ACTIVATED=0
PROBE=$PROJECT-release-probe-$RUN
if [ -f .rollback-target ]; then cp .rollback-target "$ARCHIVE/rollback-target-$RUN"; fi
restore_code() {
  local archive=$1 folder=$ARCHIVE/recovery-$RUN
  mkdir -p "$folder"
  tar xzf "$archive" -C "$folder"
  rsync -a --delete --exclude=/data --exclude='/.*' "$folder/" "$LIVE/"
}
recover() {
  trap - ERR
  helper_cli cleanup --name "$PROBE" || return 1
  if [ "$ACTIVATED" = 1 ]; then
    docker compose stop mcp </dev/null || true
    echo 'Activation needs review; writes may have resumed, so no database was rolled back.' >&2
    return 1
  fi
  # Each failed recovery step leaves the durable pause in place. Never start
  # an old image against an uncertain database or claim a partial restore.
  docker compose stop mcp </dev/null || return 1
  if [ "$CHANGED" = 1 ]; then
    [ "$BACKED_UP" = 1 ] || return 1
    helper /app/deploy/restore_release.py "$RECOVERY/pre-change.sqlite" /data/jobs.sqlite || return 1
    restore_code "$CODE_BACKUP" || return 1
  fi
  docker tag "$CURRENT_IMAGE_ID" "$IMAGE_PREFIX:0.1.0" || return 1
  if [ -n "$PREVIOUS_IMAGE" ]; then docker tag "$PREVIOUS_IMAGE" "$IMAGE_PREFIX:previous" || return 1; fi
  if [ -f "$ARCHIVE/rollback-target-$RUN" ]; then cp "$ARCHIVE/rollback-target-$RUN" .rollback-target || return 1; fi
  private_probe "$CURRENT" "$CURRENT_IMAGE_ID" || return 1
  # Old images do not honor maintenance. Once the port is opened, any writes
  # must be retained even if subsequent public verification fails.
  docker compose up -d --no-build mcp </dev/null || return 1
  verify "$CURRENT" || { docker compose stop mcp </dev/null; return 1; }
  helper -c 'from pathlib import Path; Path("/data/.release-maintenance").unlink()' || return 1
  echo 'Release failed; the previous code, website and database are restored.' >&2
}
private_probe() {
  local expected=$1 image_id=$2 ready=0
  local web_args=()
  if [ -z "$REHEARSAL_ROOT" ]; then
    web_args=(--mount "$LIVE/.web:/web:ro" --env JOBS_WEB_ROOT=/web)
  fi
  # No ports and no Docker network: even a pre-maintenance image cannot receive
  # owner/plugin traffic while startup and packaged routes are being checked.
  helper_cli start --name "$PROBE" --image "$IMAGE_PREFIX:$expected" --image-id "$image_id" --mount "$LIVE/data:/data" "${web_args[@]}" \
    --env JOBS_DB=/data/jobs.sqlite --env JOBS_ORIGIN=https://jobs.siyidu.com \
    --env JOBS_HOST=127.0.0.1 --env JOBS_PORT=8796 -- -m jobs_radar.cli serve >/dev/null || return 1
  for i in $(seq 1 30); do
    if docker exec "$PROBE" python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8796/healthz", timeout=3).close()' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then helper_cli cleanup --name "$PROBE"; return 1; fi
  if ! docker exec "$PROBE" python -c '
import urllib.request
for path in ("/", "/assets/board.js", "/assets/board.css", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"):
    with urllib.request.urlopen("http://127.0.0.1:8796" + path, timeout=10) as response:
        assert response.status == 200 and response.read(1), path
'; then helper_cli cleanup --name "$PROBE"; return 1; fi
  helper_cli cleanup --name "$PROBE"
}
verify() {
  local expected=$1 state=missing
  [ "$(cat RELEASE)" = "$expected" ] || return 1
  for i in $(seq 1 30); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-mcp-1" 2>/dev/null || echo missing)
    [ "$state" = healthy ] && break
    sleep 3
  done
  [ "$state" = healthy ] || return 1
  [ "$(docker inspect -f '{{index .Config.Labels "release"}}' "$PROJECT-mcp-1")" = "$expected" ] || return 1
  if [ "$VERIFY_MODE" = container ]; then
    docker exec "$PROJECT-mcp-1" python -c '
import urllib.request
for path in ("/healthz", "/", "/assets/board.js", "/assets/board.css", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"):
    with urllib.request.urlopen("http://127.0.0.1:8796"+path,timeout=10) as response:
        assert response.status==200 and response.read(1), path
' || return 1
    return 0
  fi
  for path in /healthz / /assets/board.js /assets/board.css /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource/mcp; do
    curl --connect-timeout 3 --max-time 10 -fsS -o /dev/null "http://127.0.0.1:8796$path" || return 1
  done
}
trap recover ERR
docker compose stop mcp </dev/null
helper /app/deploy/verify_restore.py "$RECOVERY/pre-change.sqlite" --source /data/jobs.sqlite
tar czf "$CODE_BACKUP" --exclude=./data --exclude='./.*' .
BACKED_UP=1
if [ "$MODE" = release ]; then
  helper /app/deploy/migrate_release.py /data/jobs.sqlite --report "$RECOVERY/dry-run.json"
  CHANGED=1
  helper /app/deploy/migrate_release.py /data/jobs.sqlite --apply --report "$RECOVERY/applied.json"
  rsync -a --delete --exclude=/data --exclude='/.*' --exclude=__pycache__ "$STAGE/" "$LIVE/"
else
  CHANGED=1
  restore_code "$TARGET_CODE"
fi
private_probe "$TARGET" "$EXPECTED_IMAGE_ID"
docker tag "$EXPECTED_IMAGE_ID" "$IMAGE_PREFIX:0.1.0"
# Even an unsuccessful Compose CLI may have started the public container. From
# the instant this command is issued, restoring a snapshot could discard writes.
ACTIVATED=1
docker compose up -d --no-build mcp </dev/null
verify "$TARGET"
printf '%s\n%s\n%s\n%s\n' "$CURRENT" "$CODE_BACKUP" "$CURRENT_IMAGE_ID" "$(sha256sum < "$CODE_BACKUP" | awk '{print $1}')" > .rollback-target.pending
docker tag "$CURRENT_IMAGE_ID" "$IMAGE_PREFIX:previous"
mv .rollback-target.pending .rollback-target
helper -c 'from pathlib import Path; Path("/data/.release-maintenance").unlink()'
trap - ERR
echo "Released $TARGET (previous: $CURRENT; mode: $MODE)"
