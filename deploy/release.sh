#!/usr/bin/env bash
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEPLOY_ROOT=/opt/lo-sdk-test
REPOSITORY=https://github.com/LO-ink/lo-sdk-test.git
IMAGE_REPOSITORY=ghcr.io/lo-ink/lo-sdk-test
PUBLIC_URL=https://sdk-test.zay.media
request=${1:-}
read -r -a parts <<< "$request"
actor_pattern='^[a-zA-Z0-9_-]+(\[bot\])?$'
if [[ $# != 1 || "$request" == *$'\n'* || ${#parts[@]} != 4 || ${parts[0]} != deploy || ! ${parts[1]} =~ ^sha256:[a-f0-9]{64}$ || ! ${parts[2]} =~ ^[a-f0-9]{40}$ || ! ${parts[3]} =~ $actor_pattern ]]; then
  echo 'Expected: deploy sha256:<image digest> <full commit> <GitHub actor>' >&2
  exit 64
fi
digest=${parts[1]}; revision=${parts[2]}; actor=${parts[3]}
image="$IMAGE_REPOSITORY@$digest"
umask 077
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -w 300 9
latest_main() { git ls-remote "$REPOSITORY" refs/heads/main | cut -f1; }
latest=$(latest_main) || { echo "Cannot verify current main" >&2; exit 69; }
[[ "$latest" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid main revision" >&2; exit 69; }
if [[ "$latest" != "$revision" ]]; then
  echo "Skipping superseded revision $revision"
  exit 0
fi
registry_config=$(mktemp -d "${TMPDIR:-/tmp}/lo-sdk-registry.XXXXXX")
cleanup() { rm -rf "$registry_config"; }
trap cleanup EXIT
# The job-scoped read token arrives on encrypted stdin; it is not a server secret.
DOCKER_CONFIG="$registry_config" docker login ghcr.io --username "$actor" --password-stdin >/dev/null
DOCKER_CONFIG="$registry_config" docker pull "$image" >/dev/null
rm -rf "$registry_config"
actual_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
actual_source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")
[[ "$actual_revision" == "$revision" && "$actual_source" == 'https://github.com/LO-ink/lo-sdk-test' ]] || { echo 'Image provenance labels do not match the requested release' >&2; exit 65; }
latest=$(latest_main) || { echo "Cannot verify current main" >&2; exit 69; }
[[ "$latest" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid main revision" >&2; exit 69; }
if [[ "$latest" != "$revision" ]]; then
  echo "Skipping superseded revision $revision after image pull"
  exit 0
fi
cd "$DEPLOY_ROOT"
compose() { SDK_TEST_IMAGE="$1" docker compose -p lo-sdk-test -f compose.yml "${@:2}"; }
current=$(compose "$image" ps -q web)
[[ -n "$current" ]] || { echo 'Existing production container not found; bootstrap is required' >&2; exit 66; }
previous_image=$(docker inspect --format '{{.Config.Image}}' "$current")
verify_public() {
  local public_revision
  public_revision=$(curl --fail --silent --show-error --max-time 30 "$PUBLIC_URL/release.json?revision=$revision" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])') || return 1
  [[ "$public_revision" == "$revision" ]]
}
record_release() {
  printf 'SDK_TEST_IMAGE=%s\n' "$image" > deployment.env.next
  mv deployment.env.next deployment.env
  python3 - "$image" "$revision" <<'PY'
import datetime
import json
import os
import sys

deployed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
try:
    with open('current-release.json') as source:
        previous = json.load(source)
    if (previous.get('image') == sys.argv[1]
            and previous.get('revision') == sys.argv[2]
            and isinstance(previous.get('deployedAt'), str)):
        deployed_at = previous['deployedAt']
except (OSError, ValueError, AttributeError):
    pass
with open('current-release.json.next', 'w') as destination:
    json.dump({
        'image': sys.argv[1],
        'revision': sys.argv[2],
        'deployedAt': deployed_at,
    }, destination)
os.replace('current-release.json.next', 'current-release.json')
PY
}
if [[ "$previous_image" == "$image" && $(docker inspect --format '{{.State.Health.Status}}' "$current") == healthy ]] && verify_public; then
  record_release
  echo "Already deployed $revision"
  exit 0
fi
rollback() {
  echo 'Deployment verification failed; restoring previous image' >&2
  if compose "$previous_image" up -d --no-deps --wait --wait-timeout 90 web; then
    echo 'Previous image restored' >&2
  else
    echo 'Rollback failed: inspect the lo-sdk-test service' >&2
  fi
  exit 1
}
compose "$image" up -d --no-deps --wait --wait-timeout 90 web || rollback
# Traefik may briefly retain the old backend after container replacement.
verified=false
for attempt in {1..6}; do
  if verify_public; then verified=true; break; fi
  sleep 3
done
[[ "$verified" == true ]] || rollback
record_release
echo "Deployed $revision"
