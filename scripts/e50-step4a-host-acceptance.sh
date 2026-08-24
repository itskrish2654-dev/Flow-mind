#!/usr/bin/env bash
set -euo pipefail

readonly LABEL='crazyloops.experiment=e50-step4a'
readonly EXPECTED_BRANCH='codex/e50-piece-realhost'
readonly EXPECTED_BASE='4aa554caac10a0d1cc7b55974aea2da16e5f1571'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

cleanup() {
  local ids
  ids="$(docker ps --all --quiet --filter "label=${LABEL}" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then docker rm --force $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls --quiet --filter "label=${LABEL}" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then docker network rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker image ls --quiet --filter "label=${LABEL}" 2>/dev/null | sort -u || true)"
  if [[ -n "$ids" ]]; then docker image rm --force $ids >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

if [[ "${E50_ACCEPT_STEP4A:-}" != 'YES' ]]; then
  echo 'Refusing to run without explicit confirmation.' >&2
  echo 'Review this script, then set E50_ACCEPT_STEP4A=YES.' >&2
  exit 2
fi

if [[ ! "${E50_EXPECTED_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'E50_EXPECTED_COMMIT must be the reviewed 40-character branch commit.' >&2
  exit 2
fi

for required in docker git node npx openssl curl python3 ss; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 2; }
done

branch="$(git -c safe.directory="$ROOT" -C "$ROOT" branch --show-current)"
head="$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)"
[[ "$branch" == "$EXPECTED_BRANCH" ]] || { echo "Expected branch $EXPECTED_BRANCH" >&2; exit 2; }
[[ "$head" == "$E50_EXPECTED_COMMIT" ]] || { echo 'Checkout does not match E50_EXPECTED_COMMIT.' >&2; exit 2; }
git -c safe.directory="$ROOT" -C "$ROOT" merge-base --is-ancestor "$EXPECTED_BASE" HEAD
[[ -z "$(git -c safe.directory="$ROOT" -C "$ROOT" status --porcelain)" ]] || { echo 'Checkout must be clean.' >&2; exit 2; }

docker info >/dev/null
docker_major="$(docker version --format '{{.Server.Version}}' | cut -d. -f1)"
[[ "$docker_major" =~ ^[0-9]+$ && "$docker_major" -ge 29 ]] || { echo 'Docker Server 29.x or newer is required.' >&2; exit 2; }

for protected in crazyloops-connector-runner activepieces-app activepieces-worker-1 redis; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$protected")" == 'true' ]] || { echo "Protected service is not running: $protected" >&2; exit 2; }
done

export E50_REPORT_DIRECTORY="${E50_REPORT_DIRECTORY:-/var/tmp/crazyloops-e50-step4a-reports}"
install -d -m 0700 "$E50_REPORT_DIRECTORY"

echo 'Starting fake-credential Step 4A acceptance.'
echo 'No production service will be restarted or reconfigured.'
cd "$ROOT"
npx --no-install tsx experiments/activepieces-piece-realhost/host-acceptance.ts
